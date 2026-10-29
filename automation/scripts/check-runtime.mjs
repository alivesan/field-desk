// Run inside the worker container against the mock only. All messages are synthetic.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
if (process.env.FIELD_DESK_BASE_URL !== 'http://mock:8790/api/v1') throw new Error('Mock API required');
const call = async (path, body, extraHeaders = {}) => {
  const response = await fetch(`http://127.0.0.1:8787${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.WORKER_TOKEN}`, 'Content-Type': 'application/json', ...extraHeaders }, body, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() };
};
const now = new Date();
const event = JSON.stringify({ id: randomUUID(), type: 'steam.otp.requested', at: now.toISOString(), accountUsername: 'store_alpha' });
const signature = `sha256=${createHmac('sha256', process.env.FD_WEBHOOK_SECRET).update(event).digest('hex')}`;
assert.equal((await call('/webhook', event, { 'X-FieldDesk-Signature': signature })).status, 202);
assert.equal((await call('/webhook', event, { 'X-FieldDesk-Signature': signature })).body.duplicate, true);
const message = { id: randomUUID(), internalDate: String(now.valueOf()), payload: { mimeType: 'text/plain', headers: [
  { name: 'From', value: 'noreply@steampowered.com' }, { name: 'To', value: 'central@example.invalid' },
  { name: 'Date', value: now.toUTCString() }, { name: 'X-Forwarded-To', value: 'central@example.invalid' },
  { name: 'Subject', value: 'Your Steam Guard code' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' },
], body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') } } };
const request = JSON.stringify({ mailbox: 'central-gmail', provider: 'gmail', message });
assert.equal((await call('/process', request)).body.status, 'delivered');
assert.equal((await call('/process', request)).body.status, 'already_delivered');
const response = await fetch('http://mock:8790/mock/cards');
const cards = await response.json();
assert.ok(cards.cards.find(card => card.accountUsername === 'store_alpha')?.active);
assert.ok(!JSON.stringify(cards).includes('A1B2C'));
console.log('PASS: signed request, deduplication, synthetic forwarded email and mock store card delivery. No secrets or OTP values logged.');
if (process.argv.includes('--n8n')) {
  const execution = await readFile('/app/data/n8n-demo.log', 'utf8');
  assert.match(execution, /"status"\s*:\s*"delivered"/);
  assert.match(execution, /"status"\s*:\s*"success"/);
  console.log('PASS: imported n8n demo returned a confirmed delivery and successful execution.');
  const body = JSON.stringify({ id: randomUUID(), type: 'steam.otp.requested', at: new Date().toISOString(), accountUsername: 'store_beta' });
  const signature = `sha256=${createHmac('sha256', process.env.FD_WEBHOOK_SECRET).update(body).digest('hex')}`;
  const invoke = async raw => fetch('http://n8n:5678/webhook/steam-request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FieldDesk-Signature': signature }, body: raw, signal: AbortSignal.timeout(20_000) });
  const accepted = await invoke(body); assert.equal(accepted.status, 202); assert.equal((await accepted.json()).accepted, true);
  const repeated = await invoke(body); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).duplicate, true);
  assert.equal((await invoke(body + ' ')).status, 401);
  console.log('PASS: actual n8n webhook preserves raw bytes, propagates status, deduplicates and rejects a tampered body.');
}
