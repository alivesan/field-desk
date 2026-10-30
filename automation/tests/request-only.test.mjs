import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalize, parseEmail, TTL } from '../worker/core.mjs';
import { createService } from '../worker/service.mjs';
import { createServer } from '../mock/server.mjs';

const start = Date.parse('2026-10-30T10:00:00Z');
const secret = 'synthetic-request-secret';
const box = { id: 'central-gmail', provider: 'gmail', trustedForwarders: ['source@hotmail.com'], requestOnly: true, allowRequestedRedirects: true };
const accounts = ['alpha', 'beta'].map(name => ({ username: `store_${name}`, email: `${name}@example.invalid`, assignedStoreId: `store-${name}` }));
const head = (name, value) => ({ name, value });
function mail(username = 'store_alpha', id = 'redirect-one', at = start) {
  return { id, internalDate: String(at), labelIds: ['SPAM', 'UNREAD'], payload: {
    mimeType: 'text/plain', headers: [
      head('From', 'Steam <noreply@steampowered.com>'), head('To', 'source@hotmail.com'),
      head('Date', new Date(at).toUTCString()), head('Subject', 'Your Steam account: Access from new web or mobile device'),
      head('Authentication-Results', 'mx.google.com; arc=pass; dmarc=fail header.from=steampowered.com'),
      head('Authentication-Results', 'earlier.example.invalid; dmarc=none'),
    ], body: { data: Buffer.from(`Dear ${username},\nYour Steam Guard code is: A1B2C\n`).toString('base64url') },
  } };
}
async function tempState(t) {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(new URL('requested-mail-', parent));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}
function request(service, username, at = start, id = username) {
  const raw = Buffer.from(JSON.stringify({ id, type: 'steam.otp.requested', at: new Date(at).toISOString(), accountUsername: username }));
  return service.webhook(raw, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
}

test('requested redirects need exact source recipient and body username, with age and ambiguity checks', () => {
  const policy = { ...box, requestedUsernames: ['store_alpha'] };
  assert.equal(parseEmail(normalize('gmail', mail()), start, policy).username, 'store_alpha');
  assert.throws(() => parseEmail(normalize('gmail', mail()), start), /sender_auth_unverified/);
  assert.throws(() => parseEmail(normalize('gmail', mail()), start, { ...policy, requestedUsernames: [] }), /no_active_request/);
  assert.throws(() => parseEmail(normalize('gmail', mail('store_beta')), start, policy), /no_active_request/);
  for (const recipient of ['unknown@hotmail.com', 'source@hotmail.com, other@hotmail.com']) {
    const input = mail(); input.payload.headers.find(h => h.name === 'To').value = recipient;
    assert.throws(() => parseEmail(normalize('gmail', input), start, policy), /sender_auth_unverified/);
  }
  const subjectOnly = mail();
  subjectOnly.payload.headers.find(h => h.name === 'Subject').value = 'Steam account: store_alpha';
  subjectOnly.payload.body.data = Buffer.from('Steam Guard code is: A1B2C').toString('base64url');
  assert.throws(() => parseEmail(normalize('gmail', subjectOnly), start, policy), /account_name_missing/);
  const ambiguous = mail(); ambiguous.payload.body.data = Buffer.from('Dear store_alpha,\nSteam Guard\nA1B2C\nD3E4F').toString('base64url');
  assert.throws(() => parseEmail(normalize('gmail', ambiguous), start, policy), /ambiguous_or_missing_code/);
  assert.throws(() => parseEmail(normalize('gmail', mail('store_alpha', 'stale', start - TTL)), start, policy), /expired_or_invalid_time/);
});

test('request-only mode does not scan or deliver before a signed matching request and stops on success', async t => {
  let calls = 0, posts = 0, clock = start;
  const statePath = await tempState(t);
  const service = await createService({ statePath, mailboxes: [box], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock,
    fetchImpl: async (url, init) => {
      calls++;
      if (url.endsWith('/steam/accounts')) return Response.json(accounts);
      posts++; assert.equal(JSON.parse(init.body).accountUsername, 'store_alpha'); return Response.json({ ok: true });
    } });
  assert.deepEqual((await service.due(box.id)).body, { due: false, boosted: false, query: '', mode: 'idle' });
  assert.equal((await service.process({ mailbox: box.id, provider: 'gmail', message: mail() })).body.status, 'no_active_request');
  assert.equal(calls, 0);
  assert.equal((await service.webhook(Buffer.from('{}'), 'sha256=' + '0'.repeat(64))).status, 401);
  assert.equal((await request(service, 'store_alpha')).status, 202);
  const due = (await service.due(box.id)).body;
  assert.equal(due.mode, 'boosted'); assert.match(due.query, /store_alpha/); assert.match(due.query, /-in:trash/); assert.doesNotMatch(due.query, /in:inbox|is:unread/);
  const beforeWrongAccount = calls;
  assert.equal((await service.process({ mailbox: box.id, provider: 'gmail', message: mail('store_beta', 'wrong-account') })).body.status, 'no_active_request');
  assert.equal(calls, beforeWrongAccount);
  // A fresh code already in Spam before the button press is still usable.
  clock += 30_000;
  assert.equal((await service.process({ mailbox: box.id, provider: 'gmail', message: mail() })).body.status, 'delivered');
  assert.equal(posts, 1);
  assert.equal((await service.due(box.id)).body.due, false);
  assert.equal((await service.process({ mailbox: box.id, provider: 'gmail', message: mail() })).body.status, 'already_delivered');
  assert.equal(posts, 1);
  const disk = await readFile(statePath, 'utf8');
  assert.ok(!disk.includes('A1B2C')); assert.ok(!disk.includes(secret));
});

test('request-only windows survive restart, remain per account and expire without broad polling', async t => {
  let clock = start;
  const options = { statePath: await tempState(t), mailboxes: [box], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock,
    fetchImpl: async url => url.endsWith('/steam/accounts') ? Response.json(accounts) : Response.json({ ok: true }) };
  let service = await createService(options);
  await request(service, 'store_alpha'); await request(service, 'store_beta');
  service = await createService(options);
  assert.equal((await service.process({ mailbox: box.id, provider: 'gmail', message: mail() })).body.status, 'delivered');
  const remaining = (await service.due(box.id)).body;
  assert.match(remaining.query, /store_beta/); assert.doesNotMatch(remaining.query, /store_alpha/);
  clock += TTL;
  assert.equal((await service.due(box.id)).body.mode, 'idle');
  assert.equal((await service.process({ mailbox: box.id, provider: 'gmail', message: mail('store_beta', 'fresh-but-no-request', clock) })).body.status, 'no_active_request');
});

test('request expiring during the account lookup prevents an OTP post', async t => {
  let clock = start, posts = 0, expire = false;
  const service = await createService({ statePath: await tempState(t), mailboxes: [box], baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock,
    fetchImpl: async url => {
      if (url.endsWith('/steam/accounts')) { if (expire) clock = start + TTL; return Response.json(accounts); }
      posts++; return Response.json({ ok: true });
    } });
  await request(service, 'store_alpha'); clock = start + TTL - 5000; expire = true;
  const result = await service.process({ mailbox: box.id, provider: 'gmail', message: mail('store_alpha', 'late', clock) });
  assert.equal(result.body.status, 'no_active_request'); assert.equal(posts, 0);
});

test('redirect opt-in cannot run without request-only mode or with invalid policy types', async t => {
  const options = { statePath: await tempState(t), mailboxes: [{ ...box, requestOnly: false }] };
  await assert.rejects(createService(options), /redirects_require_request_only/);
  await assert.rejects(createService({ ...options, mailboxes: [{ ...box, requestOnly: 'true' }] }), /invalid_mailbox_policy/);
});

test('signed request delivers a forwarded Spam code to the mock store card', async t => {
  const server = createServer({ apiKey: 'synthetic-api', now: () => start });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = await createService({ statePath: await tempState(t), mailboxes: [box], baseUrl: `${origin}/api/v1`, apiKey: 'synthetic-api', webhookSecret: secret, now: () => start });
  assert.equal((await request(service, 'store_alpha')).status, 202);
  const delivered = await service.process({ mailbox: box.id, provider: 'gmail', message: mail() });
  assert.equal(delivered.body.status, 'delivered'); assert.equal(delivered.body.markProcessed, true);
  const html = await (await fetch(`${origin}/mock/store`)).text();
  assert.match(html, /store_alpha/); assert.match(html, /A1B2C/);
  assert.equal((await service.due(box.id)).body.due, false);
});
