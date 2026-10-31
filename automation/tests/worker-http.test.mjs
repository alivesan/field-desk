import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as portServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { createServer } from '../mock/server.mjs';

test('HTTP worker accepts correlated batches and signed close events without leaking OTPs in replies', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('worker-http-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = createServer({ apiKey: 'synthetic-api', lookupStatus: id => id === 'http-request' ? 'open' : 'unknown' });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const reserve = portServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../worker/server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STATE_PATH: join(dir, 'state.json'), WORKER_TOKEN: 'synthetic-worker', FD_API_KEY: 'synthetic-api', FD_WEBHOOK_SECRET: 'synthetic-hook', FIELD_DESK_BASE_URL: `http://127.0.0.1:${mock.address().port}/api/v1`, MAILBOXES: JSON.stringify([{ id: 'central-gmail', provider: 'gmail', requestOnly: true }]) },
    stdio: ['ignore','pipe','pipe'], windowsHide: true,
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic worker startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', data => { if (String(data).includes('OTP worker ready')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Synthetic worker stopped before ready')); });
  });
  const origin = `http://127.0.0.1:${port}`, at = Date.now();
  const event = { id: 'http-request', requestId: 'http-request', type: 'steam.otp.requested', at: new Date(at).toISOString(), requestedAt: new Date(at).toISOString(), acceptFrom: new Date(at - 60000).toISOString(), watchUntil: new Date(at + 600000).toISOString(), storeId: 'store-alpha', accountUsername: 'store_alpha' };
  const post = (path, body, signed = false) => {
    const raw = JSON.stringify(body);
    return fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer synthetic-worker', 'Content-Type': 'application/json', ...(signed ? { 'X-FieldDesk-Signature': 'sha256=' + createHmac('sha256', 'synthetic-hook').update(raw).digest('hex') } : {}) }, body: raw });
  };
  assert.equal((await post('/webhook', event, true)).status, 202);
  const message = { id: 'synthetic-http-message', internalDate: String(at), payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'noreply@steampowered.com' }, { name: 'Date', value: new Date(at).toUTCString() },
    { name: 'Subject', value: 'Steam Guard code' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' },
  ], body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code: A1B2C').toString('base64url') } } };
  const response = await post('/process-batch', { mailbox: 'central-gmail', provider: 'gmail', requestIds: ['http-request'], messages: [message] });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.results[0].status, 'delivered'); assert.ok(!JSON.stringify(result).includes('A1B2C'));
  const close = { id: 'close-http', type: 'steam.otp.request.closed', at: new Date().toISOString(), requestId: 'http-request', storeId: 'store-alpha', accountUsername: 'store_alpha', reason: 'dismissed' };
  assert.equal((await post('/webhook', close, true)).status, 202);
  assert.equal((await post('/webhook', close, true)).status, 200);
  assert.equal((await post('/process-batch', { messages: Array(251).fill({}) })).status, 400);
});
