import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { normalize, parseEmail, matchAccount, TTL, verifySignature } from '../worker/core.mjs';
import { createService } from '../worker/service.mjs';

const instant = Date.parse('2026-10-25T07:00:00Z');
function gmail(overrides = {}) {
  return { id: 'message-one', internalDate: String(instant), payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'Steam <noreply@steampowered.com>' }, { name: 'To', value: 'login-alpha@example.invalid' },
    { name: 'Subject', value: 'Your Steam Guard code' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' }],
  body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') } }, ...overrides };
}
const accounts = [{ username: 'store_alpha', email: 'login-alpha@example.invalid', assignedStoreId: 'store-alpha' }];
test('Gmail and Outlook normalize login and HTML new-device formats', () => {
  assert.equal(parseEmail(normalize('gmail', gmail()), instant).code, 'A1B2C');
  const message = { id: 'outlook-one', from: { emailAddress: { address: 'noreply@steampowered.com' } }, toRecipients: [{ emailAddress: { address: 'login-alpha@example.invalid' } }], receivedDateTime: new Date(instant).toISOString(), subject: 'Access from a new computer', body: { contentType: 'HTML', content: '<div>Dear store_alpha,</div><div>A1B2C</div>' }, internetMessageHeaders: [{ name: 'Authentication-Results', value: 'dmarc=pass header.from=steampowered.com;' }] };
  assert.equal(matchAccount(parseEmail(normalize('outlook', message), instant), accounts).username, 'store_alpha');
});
test('expiry, future times, sender, authentication and ambiguous codes fail closed', () => {
  const email = normalize('gmail', gmail());
  for (const change of [ { receivedAt: new Date(instant - TTL).toISOString() }, { receivedAt: new Date(instant + 31_000).toISOString() }, { sender: ['attacker@example.invalid'] }, { auth: 'dmarc=fail header.from=steampowered.com' }, { auth: 'dmarc=pass header.from=steampowered.com.evil.test' }, { authCount: 2 }, { auth: 'dmarc=fail header.from=steampowered.com; dmarc=pass header.from=steampowered.com' }, { text: 'A1B2C\nD3E4F' } ]) assert.throws(() => parseEmail({ ...email, ...change }, instant));
});
test('explicit unknown username never falls back, duplicate recipients never guess', () => {
  const parsed = parseEmail(normalize('gmail', gmail()), instant);
  assert.throws(() => matchAccount({ ...parsed, username: 'unknown' }, accounts));
  assert.throws(() => matchAccount({ ...parsed, username: null }, [...accounts, { ...accounts[0], username: 'second' }]));
  assert.equal(matchAccount({ ...parsed, username: null }, accounts).username, 'store_alpha');
});
test('HMAC covers exact raw bytes', () => {
  const raw = Buffer.from('{"type":"steam.otp.requested"}'); const secret = 'synthetic-test-secret';
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifySignature(raw, sig, secret), true);
  assert.equal(verifySignature(Buffer.concat([raw, Buffer.from(' ')]), sig, secret), false);
});
test('persistent dedupe, concurrent delivery, retry, no plaintext state, and boost windows', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('fd-otp-test-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = instant, posts = 0, fail = false;
  const options = { statePath: join(dir, 'state.json'), mailboxes: [{ id: 'gmail-1', provider: 'gmail' }], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: 'synthetic-secret', now: () => clock, fetchImpl: async (url, init) => {
    if (url.endsWith('/steam/accounts')) return Response.json(accounts);
    if (fail) return new Response('', { status: 503 });
    posts++; assert.equal(JSON.parse(init.body).accountUsername, 'store_alpha'); assert.ok(init.headers['Idempotency-Key']); return Response.json({ ok: true });
  } };
  let service = await createService(options); const input = { mailbox: 'gmail-1', provider: 'gmail', message: gmail() };
  const results = await Promise.all([service.process(input), service.process(input)]);
  assert.ok(results.every(r => r.body.markProcessed)); assert.equal(posts, 1);
  service = await createService(options); assert.equal((await service.process(input)).body.status, 'already_delivered'); assert.equal(posts, 1);
  fail = true; const retry = { ...input, message: gmail({ id: 'message-two' }) };
  assert.equal((await service.process(retry)).body.markProcessed, false);
  fail = false; assert.equal((await service.process(retry)).body.markProcessed, true); assert.equal(posts, 2);
  const disk = await readFile(options.statePath, 'utf8'); for (const forbidden of ['A1B2C', 'store_alpha', 'login-alpha', 'Steam Guard', 'synthetic-secret']) assert.ok(!disk.includes(forbidden));
  assert.equal((await service.due('gmail-1')).body.due, true); clock += 15_000; assert.equal((await service.due('gmail-1')).body.due, false);
  const event = JSON.stringify({ id: 'request-one', type: 'steam.otp.requested', at: new Date(clock).toISOString(), accountUsername: 'store_alpha' });
  const signature = `sha256=${createHmac('sha256', options.webhookSecret).update(event).digest('hex')}`;
  assert.equal((await service.webhook(Buffer.from(event), signature)).status, 202);
  assert.equal((await service.webhook(Buffer.from(event), signature)).body.duplicate, true);
  assert.equal((await service.due('gmail-1')).body.due, true); clock += 15_000; assert.equal((await service.due('gmail-1')).body.due, true);
  clock += TTL; assert.equal((await service.due('gmail-1')).body.boosted, false);
  assert.equal((await service.webhook(Buffer.from(event), signature)).status, 400);
});
