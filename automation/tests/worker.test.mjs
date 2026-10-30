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
    { name: 'Date', value: new Date(instant).toUTCString() }, { name: 'Subject', value: 'Your Steam Guard code' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' }],
  body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') } }, ...overrides };
}
const accounts = [{ username: 'store_alpha', email: 'login-alpha@example.invalid', assignedStoreId: 'store-alpha' }, { username: 'store_beta', email: 'login-beta@example.invalid', assignedStoreId: 'store-beta' }];

test('production blocks current and legacy mock demos before any API call', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('fd-otp-production-guard-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const service = await createService({ statePath: join(dir, 'state.json'), mailboxes: [{ id: 'central-gmail', provider: 'gmail' }], baseUrl: 'https://fieldesk.runs-at.dev/api/v1', apiKey: 'synthetic', webhookSecret: 'synthetic', now: () => instant,
    fetchImpl: async url => { requests++; return url.endsWith('/steam/accounts') ? Response.json(accounts) : Response.json({ ok: true }); } });
  for (const entry of [{ mockOnly: true, message: gmail() }, { message: gmail({ id: 'mock-demo-123' }) }, { message: gmail({ id: 'synthetic-demo' }) }]) {
    const result = await service.process({ mailbox: 'central-gmail', provider: 'gmail', ...entry });
    assert.equal(result.status, 400); assert.equal(result.body.status, 'mock_only_blocked');
  }
  assert.equal(requests, 0);
  assert.equal((await service.process({ mailbox: 'central-gmail', provider: 'gmail', message: gmail() })).body.status, 'delivered');
  assert.equal(requests, 2);
});
test('Gmail direct message maps only by explicit username', () => {
  assert.equal(parseEmail(normalize('gmail', gmail()), instant).code, 'A1B2C');
  assert.equal(matchAccount(parseEmail(normalize('gmail', gmail()), instant), accounts).username, 'store_alpha');
});
test('expiry, future times, sender, authentication and ambiguous codes fail closed', () => {
  const email = normalize('gmail', gmail());
  for (const change of [ { receivedAt: new Date(instant - TTL).toISOString() }, { receivedAt: new Date(instant + 31_000).toISOString() }, { sender: ['attacker@example.invalid'] }, { auth: 'dmarc=fail header.from=steampowered.com' }, { auth: 'dmarc=pass header.from=steampowered.com.evil.test' }, { authCount: 2 }, { auth: 'dmarc=fail header.from=steampowered.com; dmarc=pass header.from=steampowered.com' }, { text: 'A1B2C\nD3E4F' } ]) assert.throws(() => parseEmail({ ...email, ...change }, instant));
});
test('explicit username is required even when a recipient would match', () => {
  const parsed = parseEmail(normalize('gmail', gmail()), instant);
  assert.throws(() => matchAccount({ ...parsed, username: 'unknown' }, accounts));
  assert.throws(() => matchAccount({ ...parsed, username: null }, accounts), /account_name_missing/);
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
  const options = { statePath: join(dir, 'state.json'), mailboxes: [{ id: 'central-gmail', provider: 'gmail', trustedForwarders: ['relay@example.com'] }], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: 'synthetic-secret', now: () => clock, fetchImpl: async (url, init) => {
    if (url.endsWith('/steam/accounts')) return Response.json(accounts);
    if (fail) return new Response('', { status: 503 });
    posts++; assert.equal(JSON.parse(init.body).accountUsername, 'store_alpha'); assert.ok(init.headers['Idempotency-Key']); return Response.json({ ok: true });
  } };
  let service = await createService(options); const input = { mailbox: 'central-gmail', provider: 'gmail', message: gmail() };
  const results = await Promise.all([service.process(input), service.process(input)]);
  assert.ok(results.every(r => r.body.markProcessed)); assert.equal(posts, 1);
  service = await createService(options); assert.equal((await service.process(input)).body.status, 'already_delivered'); assert.equal(posts, 1);
  fail = true; const retry = { ...input, message: gmail({ id: 'message-two' }) };
  assert.equal((await service.process(retry)).body.markProcessed, false);
  fail = false; assert.equal((await service.process(retry)).body.markProcessed, true); assert.equal(posts, 2);
  const disk = await readFile(options.statePath, 'utf8'); for (const forbidden of ['A1B2C', 'Steam Guard', 'synthetic-secret']) assert.ok(!disk.includes(forbidden));
  const normal = (await service.due('central-gmail')).body; assert.equal(normal.due, true); assert.equal(normal.mode, 'normal'); assert.equal(typeof normal.query, 'string');
  clock += 15_000; assert.equal((await service.due('central-gmail')).body.due, false);
  const event = JSON.stringify({ id: 'request-one', type: 'steam.otp.requested', at: new Date(clock).toISOString(), accountUsername: 'store_alpha' });
  const signature = `sha256=${createHmac('sha256', options.webhookSecret).update(event).digest('hex')}`;
  assert.equal((await service.webhook(Buffer.from(event), signature)).status, 202);
  assert.equal((await service.webhook(Buffer.from(event), signature)).body.duplicate, true);
  const boosted = (await service.due('central-gmail')).body; assert.equal(boosted.due, true); assert.equal(boosted.mode, 'boosted'); assert.match(boosted.query, /store_alpha/i);
  clock += 15_000; assert.equal((await service.due('central-gmail')).body.due, true);
  clock += TTL; assert.equal((await service.due('central-gmail')).body.boosted, false);
  assert.equal((await service.webhook(Buffer.from(event), signature)).status, 400);
});

test('two account boosts expire independently and delivery clears only its account across restart', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('fd-otp-two-boosts-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = instant;
  const secret = 'two-boost-secret';
  const options = { statePath: join(dir, 'state.json'), mailboxes: [{ id: 'central-gmail', provider: 'gmail' }], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock, fetchImpl: async (url) => url.endsWith('/steam/accounts') ? Response.json(accounts) : Response.json({ ok: true }) };
  let service = await createService(options);
  const request = async (id, accountUsername) => {
    const raw = Buffer.from(JSON.stringify({ id, type: 'steam.otp.requested', at: new Date(clock).toISOString(), accountUsername }));
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return service.webhook(raw, signature);
  };
  assert.equal((await request('alpha', 'store_alpha')).status, 202);
  clock += 10_000;
  assert.equal((await request('beta', 'STORE_BETA')).status, 202);
  const both = (await service.due('central-gmail')).body;
  assert.equal(both.mode, 'normal');
  clock += 15_000;
  const fast = (await service.due('central-gmail')).body;
  assert.equal(fast.mode, 'boosted'); assert.match(fast.query, /store_alpha/); assert.match(fast.query, /store_beta/);
  const alphaMessage = gmail({ id: 'alpha-complete', internalDate: String(clock) });
  alphaMessage.payload.headers.find(h => h.name === 'Date').value = new Date(clock).toUTCString();
  assert.equal((await service.process({ mailbox: 'central-gmail', provider: 'gmail', message: alphaMessage })).body.status, 'delivered');
  service = await createService(options);
  clock += 15_000;
  const betaOnly = (await service.due('central-gmail')).body;
  assert.equal(betaOnly.boosted, true); assert.equal(betaOnly.mode, 'boosted');
  assert.match(betaOnly.query, /store_beta/); assert.doesNotMatch(betaOnly.query, /store_alpha/);
  clock = instant + TTL + 1;
  assert.equal((await service.due('central-gmail')).body.boosted, true);
  clock = instant + 10_000 + TTL;
  assert.equal((await service.due('central-gmail')).body.boosted, false);
});

test('webhook rejects conflicting identifiers and cannot create an ambiguous boost', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('fd-otp-ambiguous-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = 'ambiguous-secret';
  const service = await createService({ statePath: join(dir, 'state.json'), mailboxes: [{ id: 'central-gmail', provider: 'gmail' }], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => instant, fetchImpl: async () => Response.json(accounts) });
  const event = { id: 'conflict', type: 'steam.otp.requested', at: new Date(instant).toISOString(), accountUsername: 'store_alpha', accountEmail: 'login-beta@example.invalid' };
  const raw = Buffer.from(JSON.stringify(event));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal((await service.webhook(raw, signature)).status, 400);
  assert.equal((await service.due('central-gmail')).body.boosted, false);
});

test('duplicate request cannot extend a boost but a new request can refresh it', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('fd-otp-refresh-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = instant;
  const secret = 'refresh-secret';
  const service = await createService({ statePath: join(dir, 'state.json'), mailboxes: [{ id: 'central-gmail', provider: 'gmail' }], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock, fetchImpl: async () => Response.json(accounts) });
  const signed = id => {
    const raw = Buffer.from(JSON.stringify({ id, type: 'steam.otp.requested', at: new Date(clock).toISOString(), accountUsername: 'store_alpha' }));
    return [raw, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`];
  };
  const first = signed('first');
  assert.equal((await service.webhook(...first)).status, 202);
  clock += 30_000;
  assert.equal((await service.webhook(...first)).body.duplicate, true);
  const duplicateState = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(Object.values(duplicateState.boosts)[0].until, instant + TTL);
  clock = instant + TTL - 30_000;
  const second = signed('second');
  assert.equal((await service.webhook(...second)).status, 202);
  clock = instant + TTL + 1;
  assert.equal((await service.due('central-gmail')).body.boosted, true);
  clock = instant + 2 * TTL - 30_000;
  assert.equal((await service.due('central-gmail')).body.boosted, false);
});

test('a fresh pre-request email delivers without clearing the newer account boost', async t => {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('fd-otp-pre-request-', parent)); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = instant + 60_000;
  let posts = 0;
  const secret = 'pre-request-secret';
  const service = await createService({ statePath: join(dir, 'state.json'), mailboxes: [{ id: 'central-gmail', provider: 'gmail' }], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock, fetchImpl: async (url) => {
    if (url.endsWith('/steam/accounts')) return Response.json(accounts);
    posts++; return Response.json({ ok: true });
  } });
  const raw = Buffer.from(JSON.stringify({ id: 'new-login-request', type: 'steam.otp.requested', at: new Date(clock).toISOString(), accountUsername: 'store_alpha' }));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal((await service.webhook(raw, signature)).status, 202);
  assert.equal((await service.due('central-gmail')).body.mode, 'normal');
  const olderMail = { mailbox: 'central-gmail', provider: 'gmail', message: gmail({ id: 'unprocessed-before-request' }) };
  assert.equal((await service.process(olderMail)).body.status, 'delivered');
  assert.equal(posts, 1);
  assert.equal((await service.process(olderMail)).body.status, 'already_delivered');
  clock += 15_000;
  const next = (await service.due('central-gmail')).body;
  assert.equal(next.mode, 'boosted');
  assert.equal(next.boosted, true);
  assert.match(next.query, /store_alpha/);
});
