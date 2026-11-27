import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createService } from '../worker/service.mjs';
import { TTL } from '../worker/core.mjs';
import { createServer } from '../mock/server.mjs';

const start = Date.parse('2026-10-30T18:00:00Z'), secret = 'synthetic-lookups-secret';
const boxes = [{ id: 'central-gmail', provider: 'gmail', requestOnly: true, allowRequestedRedirects: true, trustedForwarders: ['relay@example.invalid'] }];
const accounts = ['alpha','beta'].map(name => ({ username: `store_${name}`, email: `${name}@example.invalid`, assignedStoreId: `store-${name}` }));
const requested = (id, at = start, name = 'alpha') => ({ id, requestId: id, type: 'steam.otp.requested', at: new Date(at).toISOString(), requestedAt: new Date(at).toISOString(), acceptFrom: new Date(at - 60000).toISOString(), watchUntil: new Date(at + TTL).toISOString(), storeId: `store-${name}`, accountUsername: `store_${name}` });
const closed = (requestId, at = start, name = 'alpha', reason = 'dismissed') => ({ id: `close-${requestId}`, type: 'steam.otp.request.closed', at: new Date(at).toISOString(), requestId, storeId: `store-${name}`, accountUsername: `store_${name}`, reason });
const signed = event => { const raw = Buffer.from(JSON.stringify(event)); return [raw, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`]; };
function email(id, at = start, name = 'alpha', arrival = at, code = 'A1B2C') {
  return { id, internalDate: String(arrival), labelIds: ['SPAM'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'noreply@steampowered.com' }, { name: 'To', value: '"relay@example.invalid" <relay@example.invalid>' },
    { name: 'Date', value: new Date(at).toUTCString() }, { name: 'Subject', value: 'Steam Guard code' },
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail header.from=steampowered.com; arc=pass' },
  ], body: { data: Buffer.from(`Login to store_${name} using this Steam Guard code:\n${code}`).toString('base64url') } } };
}
async function harness(t, behavior = () => ({})) {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(new URL('lookup-contract-', parent)); t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = start, calls = 0;
  const posts = [], statePath = join(directory, 'state.json');
  const options = { statePath, mailboxes: boxes, baseUrl: 'http://mock/api/v1', apiKey: 'synthetic', webhookSecret: secret, now: () => clock,
    fetchImpl: async (url, init) => {
      calls++;
      if (url.endsWith('/steam/accounts')) return Response.json(accounts);
      const body = JSON.parse(init.body); posts.push({ body, key: init.headers['Idempotency-Key'] });
      const extra = await behavior(body, posts.length);
      return Response.json({ ok: true, displayed: true, request: { id: body.requestId, status: 'open' }, ...extra });
    } };
  let service = await createService(options);
  return { posts, options, get service() { return service; }, set time(value) { clock = value; }, get calls() { return calls; },
    restart: async () => { service = await createService(options); },
    event: event => service.webhook(...signed(event)),
    process: (message, requestIds) => service.process({ mailbox: boxes[0].id, provider: 'gmail', message, ...(requestIds ? { requestIds } : {}) }),
    batch: (messages, requestIds) => service.processBatch({ mailbox: boxes[0].id, provider: 'gmail', messages, requestIds }),
    due: async () => (await service.due(boxes[0].id)).body,
  };
}

test('close before open survives restart, deduplicates and never calls the account API', async t => {
  const h = await harness(t);
  assert.equal((await h.event(closed('first'))).status, 202);
  assert.equal((await h.event(closed('first'))).body.duplicate, true);
  await h.restart();
  assert.equal((await h.event(requested('first'))).body.closed, true);
  assert.equal(h.calls, 0); assert.equal((await h.due()).due, false);
});

test('superseded close and delayed older opens cannot cancel or replace the new lookup', async t => {
  const h = await harness(t);
  await h.event(requested('first'));
  h.time = start + 6000; await h.event(requested('second', start + 6000));
  await h.event(closed('first', start + 6000, 'alpha', 'superseded'));
  assert.equal((await h.event(requested('late-old', start + 1000))).body.superseded, true);
  const due = await h.due(); assert.deepEqual(due.requestIds, ['second']);
  const before = h.calls;
  assert.equal((await h.process(email('old-scan', start + 6000), ['first'])).body.status, 'superseded_scan');
  assert.equal(h.calls, before);
  await h.restart(); h.time = start + 21000;
  assert.deepEqual((await h.due()).requestIds, ['second']);
});

test('freshness accepts the inclusive minus-60-second boundary, never the previous second', async t => {
  const h = await harness(t); await h.event(requested('window'));
  assert.equal((await h.process(email('too-old', start - 61000, 'alpha', start))).body.status, 'outside_lookup_window');
  assert.equal(h.posts.length, 0);
  const accepted = await h.process(email('boundary', start - 60000, 'alpha', start));
  assert.equal(accepted.body.status, 'delivered'); assert.equal(h.posts[0].body.requestId, 'window');
  assert.equal(h.posts[0].body.receivedAt, new Date(start - 60000).toISOString());
  assert.equal((await h.due()).due, false);
});

test('scan query keeps the fixed request cutoff and watching continues beyond one minute', async t => {
  const h = await harness(t); await h.event(requested('long-watch'));
  const first = await h.due();
  h.time = start + 9 * 60000;
  assert.equal((await h.due()).query, first.query);
  assert.equal((await h.process(email('late-arrival', start - 30000, 'alpha', start + 9 * 60000))).body.status, 'delivered');
  h.time = start + TTL;
  assert.equal((await h.due()).due, false);
});

test('batch chooses newest original email Date despite reversed Gmail and arrival ordering', async t => {
  const h = await harness(t); await h.event(requested('newest'));
  h.time = start + 30000;
  const result = await h.batch([email('old', start + 1000, 'alpha', start + 25000, 'Z9Y8X'), email('new', start + 5000, 'alpha', start + 10000)], ['newest']);
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].body.receivedAt, new Date(start + 5000).toISOString());
  assert.equal(result.body.results.find(r => r.status === 'delivered').messageId, 'new');
  assert.equal(result.body.results.filter(r => r.status === 'older_candidate').length, 1);
});

test('a new email with the same code answers the next request with a different email key', async t => {
  const h = await harness(t); await h.event(requested('pc-one'));
  assert.equal((await h.process(email('email-one'))).body.status, 'delivered');
  h.time = start + 6000; await h.event(requested('pc-two', start + 6000));
  assert.equal((await h.process(email('email-one'))).body.status, 'already_delivered');
  assert.equal((await h.process(email('email-two', start + 6000))).body.status, 'delivered');
  assert.equal(h.posts.length, 2); assert.equal(h.posts[0].body.code, h.posts[1].body.code);
  assert.notEqual(h.posts[0].key, h.posts[1].key); assert.equal(h.posts[1].body.requestId, 'pc-two');
});

test('stored but not displayed stays watching and does not post the same email twice', async t => {
  const h = await harness(t, (_body, count) => ({ displayed: count > 1 }));
  await h.event(requested('seen-through'));
  assert.equal((await h.process(email('already-seen'))).body.status, 'stored_not_displayed');
  assert.equal((await h.due()).boosted, true);
  assert.equal((await h.process(email('already-seen'))).body.status, 'already_delivered');
  h.time = start + 1000;
  assert.equal((await h.process(email('new-email', start + 1000))).body.status, 'delivered');
  assert.equal((await h.due()).boosted, false);
});

for (const status of ['closed','unknown']) test(`API request status ${status} stops its window`, async t => {
  const h = await harness(t, body => ({ displayed: false, request: { id: body.requestId, status } }));
  await h.event(requested(`reply-${status}`));
  assert.equal((await h.process(email(`email-${status}`))).body.status, `request_${status}`);
  await h.restart(); assert.equal((await h.due()).boosted, false);
});

test('mismatched or missing correlated response is not recorded as delivered', async t => {
  for (const extra of [{ request: { id: 'wrong', status: 'open' } }, { request: null }, { displayed: undefined }]) {
    const h = await harness(t, () => extra); await h.event(requested('response-check'));
    assert.equal((await h.process(email('response-message'))).body.status, 'invalid_delivery_response');
    assert.equal((await h.due()).boosted, true);
    const state = JSON.parse(await readFile(h.options.statePath, 'utf8'));
    assert.equal(Object.keys(state.delivered).length, 0);
  }
});

test('a failed newest email prevents fallback to older mail and retry keeps its idempotency key', async t => {
  let fail = true;
  const h = await harness(t, () => { if (fail) throw new Error('synthetic network failure'); return {}; });
  await h.event(requested('retry-newest')); h.time = start + 10000;
  const old = email('old-candidate', start), newest = email('newest-candidate', start + 1000);
  await h.batch([old, newest], ['retry-newest']); assert.equal(h.posts.length, 1);
  assert.equal((await h.process(old)).body.status, 'older_than_selected');
  await h.restart(); fail = false;
  assert.equal((await h.process(newest)).body.status, 'delivered');
  assert.equal(h.posts.length, 2); assert.equal(h.posts[0].key, h.posts[1].key);
});

test('close can interleave between batch accounts so the second account is never posted', async t => {
  let h, closing;
  h = await harness(t, body => {
    if (body.accountUsername === 'store_alpha') closing = h.event(closed('beta-request', start, 'beta'));
    return {};
  });
  await h.event(requested('alpha-request')); await h.event(requested('beta-request', start, 'beta'));
  h.time = start + 1000;
  await h.batch([email('alpha-email', start + 1000), email('beta-email', start, 'beta')], ['alpha-request','beta-request']);
  await closing;
  assert.deepEqual(h.posts.map(p => p.body.accountUsername), ['store_alpha']);
});

test('wrong signatures and malformed request/close metadata do not change windows', async t => {
  const h = await harness(t);
  const [raw] = signed(closed('forged'));
  assert.equal((await h.service.webhook(raw, 'sha256=' + '0'.repeat(64))).status, 401);
  for (const event of [
    { ...requested('bad'), requestId: 'different' }, { ...requested('bad'), acceptFrom: new Date(start - 120000).toISOString() },
    { ...requested('bad'), watchUntil: new Date(start + TTL + 1000).toISOString() },
    { ...closed('bad'), reason: 'anything' }, { ...closed('bad'), requestId: 'has space' },
    { ...requested('bad'), storeId: 'another-store' },
  ]) assert.equal((await h.event(event)).status, 400);
  assert.equal((await h.due()).due, false);
});

test('ledger contains no code, message body or credentials after correlated delivery', async t => {
  const h = await harness(t); await h.event(requested('privacy'));
  await h.process(email('private-message'));
  const disk = await readFile(h.options.statePath, 'utf8');
  for (const value of ['A1B2C','Steam Guard code',secret]) assert.ok(!disk.includes(value));
});

test('correlated newest Spam batch reaches the mock over HTTP and closes its worker window', async t => {
  let clock = start;
  const mock = createServer({ apiKey: 'synthetic', now: () => clock, lookupStatus: id => id === 'http-lookup' ? 'open' : 'unknown' });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const h = await harness(t);
  const origin = `http://127.0.0.1:${mock.address().port}`;
  const service = await createService({ ...h.options, baseUrl: `${origin}/api/v1`, fetchImpl: fetch });
  assert.equal((await service.webhook(...signed(requested('http-lookup')))).status, 202);
  clock = start + 10000; h.time = clock;
  const outcome = await service.processBatch({ mailbox: boxes[0].id, provider: 'gmail', requestIds: ['http-lookup'], messages: [email('old-http', start), email('new-http', start + 1000, 'alpha', clock, 'Z9Y8X')] });
  assert.equal(outcome.body.results.find(r => r.status === 'delivered').messageId, 'new-http');
  const html = await (await fetch(`${origin}/mock/store`)).text();
  assert.match(html, /Z9Y8X/); assert.doesNotMatch(html, /A1B2C/);
  assert.equal((await service.due(boxes[0].id)).body.boosted, false);
});

test('mock recomputes request status on idempotent retries without changing code expiry', async t => {
  let clock = start, status = 'open';
  const mock = createServer({ apiKey: 'synthetic', now: () => clock, lookupStatus: () => status });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const origin = `http://127.0.0.1:${mock.address().port}`;
  const payload = { accountUsername: 'store_alpha', code: 'A1B2C', receivedAt: new Date(start).toISOString(), requestId: 'first' };
  const post = body => fetch(`${origin}/api/v1/steam/otp`, { method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', 'Idempotency-Key': 'same-email-identity' }, body: JSON.stringify(body) });
  const first = await (await post(payload)).json(); assert.equal(first.displayed, true);
  status = 'closed';
  const repeated = await (await post(payload)).json(); assert.equal(repeated.displayed, false); assert.equal(repeated.request.status, 'closed');
  status = 'open';
  const rebound = await (await post({ ...payload, requestId: 'second' })).json();
  assert.deepEqual(rebound.request, { id: 'second', status: 'open' }); assert.equal(rebound.duplicate, true);
  clock = start + TTL;
  const late = await post(payload); assert.equal(late.status, 200);
  const expired = await late.json(); assert.equal(expired.displayed, false); assert.equal(expired.expiresAt, first.expiresAt);
  for (const requestId of ['', 'has space', 'unicode-☃', 'x'.repeat(201), 123]) assert.equal((await post({ ...payload, requestId })).status, 400);
});
