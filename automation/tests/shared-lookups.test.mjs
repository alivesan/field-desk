import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createService } from '../worker/service.mjs';
import { matchAccount, eligibleStores, digest, TTL } from '../worker/core.mjs';
import { createServer } from '../mock/server.mjs';

const start = Date.parse('2026-10-31T06:00:00Z'), secret = 'synthetic-shared-secret';
const boxes = [{ id: 'central-gmail', provider: 'gmail', requestOnly: true }];
const shared = () => ({ username: 'shared_account', email: 'shared@example.invalid', assignedStoreId: null, eligibleStoreIds: ['store-a','store-b'], holders: ['a','b'].map(n => ({ storeId: `store-${n}`, storeName: n, purpose: 'download', date: '2026-10-31' })) });
const signed = event => { const raw = Buffer.from(JSON.stringify(event)); return [raw, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`]; };
function message(id, at = start, code = 'A1B2C') {
  return { id, internalDate: String(at), labelIds: ['SPAM'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'noreply@steampowered.com' }, { name: 'Date', value: new Date(at).toUTCString() },
    { name: 'Subject', value: 'Steam Guard code' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' },
  ], body: { data: Buffer.from(`Dear shared_account,\nSteam Guard code: ${code}`).toString('base64url') } } };
}
const request = (id, storeId, at = start, ids = ['store-a','store-b']) => ({ id, requestId: id, type: 'steam.otp.requested', at: new Date(at).toISOString(), requestedAt: new Date(at).toISOString(), acceptFrom: new Date(at - 60000).toISOString(), watchUntil: new Date(at + TTL).toISOString(), storeId, accountUsername: 'shared_account', eligibleStoreIds: ids });
const close = (id, storeId, at = start) => ({ id: `close-${id}`, type: 'steam.otp.request.closed', at: new Date(at).toISOString(), requestId: id, storeId, accountUsername: 'shared_account', reason: 'dismissed' });
async function setup(t, behavior = () => ({})) {
  const parent = new URL('../test-output/', import.meta.url); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(new URL('shared-lookups-', parent)); t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = start, account = shared(), shown = ['store-a','store-b'], gets = 0;
  const requests = new Map(), posts = [], statePath = join(directory, 'state.json');
  const options = { statePath, mailboxes: boxes, baseUrl: 'http://mock/api/v1', apiKey: 'synthetic-api', webhookSecret: secret, now: () => clock,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/steam/accounts')) { gets++; return Response.json([account]); }
      const body = JSON.parse(init.body); posts.push({ body, key: init.headers['Idempotency-Key'] });
      const lookup = requests.get(body.requestId), displayed = shown.includes(lookup?.storeId);
      const extra = await behavior(body, posts.length);
      return Response.json({ ok: true, assignedStoreId: account.assignedStoreId, eligibleStoreIds: account.eligibleStoreIds, displayedStoreIds: shown, displayed, request: { id: body.requestId, status: lookup?.status || 'unknown' }, ...extra });
    } };
  let service = await createService(options);
  return { posts, requests, options, get service() { return service; }, get gets() { return gets; }, set time(value) { clock = value; }, set account(value) { account = value; }, set shown(value) { shown = value; },
    event: async event => { if (event.type === 'steam.otp.requested') requests.set(event.id, { storeId: event.storeId, status: 'open' }); else if (requests.has(event.requestId)) requests.get(event.requestId).status = 'closed'; return service.webhook(...signed(event)); },
    due: async () => (await service.due(boxes[0].id)).body,
    process: (mail, requestIds) => service.process({ mailbox: boxes[0].id, provider: 'gmail', message: mail, ...(requestIds ? { requestIds } : {}) }),
    batch: (messages, requestIds) => service.processBatch({ mailbox: boxes[0].id, provider: 'gmail', messages, requestIds }),
    restart: async () => { service = await createService(options); },
  };
}

test('shared holder lists are authoritative even with no primary, and empty lists cannot use a primary fallback', () => {
  assert.equal(matchAccount({ username: 'shared_account' }, [shared()]).assignedStoreId, null);
  assert.throws(() => matchAccount({ username: 'shared_account' }, [{ ...shared(), assignedStoreId: 'store-a', eligibleStoreIds: [] }]), /unmatched_or_ambiguous_account/);
  assert.throws(() => eligibleStores({ eligibleStoreIds: 'store-a' }), /invalid_accounts_response/);
  assert.deepEqual(eligibleStores({ assignedStoreId: 'legacy-store' }), ['legacy-store']);
});

test('signed holder events need membership and do not call the directory to acknowledge', async t => {
  const h = await setup(t);
  assert.equal((await h.event(request('a', 'store-a'))).status, 202);
  assert.equal((await h.event(request('invalid', 'outside-store'))).status, 400);
  assert.equal((await h.event(request('empty', 'store-a', start, []))).status, 400);
  assert.equal(h.gets, 0);
  assert.deepEqual((await h.due()).requestIds, ['a']);
});

test('same-account lookups from different stores coexist across restart and share one username query', async t => {
  const h = await setup(t); h.time = start + 10000;
  await h.event(request('a-newer', 'store-a', start + 6000));
  await h.event(request('b-older', 'store-b', start));
  await h.restart();
  const due = await h.due(); assert.deepEqual(new Set(due.requestIds), new Set(['a-newer','b-older']));
  assert.equal((due.query.match(/"shared_account"/g) || []).length, 1);
  const disk = JSON.parse(await readFile(h.options.statePath, 'utf8'));
  assert.ok(disk.boosts[digest('a-newer')]); assert.ok(disk.boosts[digest('b-older')]);
});

test('a close ends only its request, including after restart', async t => {
  const h = await setup(t); await h.event(request('a', 'store-a')); await h.event(request('b', 'store-b'));
  assert.equal((await h.event(close('a', 'store-a'))).status, 202);
  assert.equal((await h.event(close('a', 'store-a'))).body.duplicate, true);
  await h.restart(); assert.deepEqual((await h.due()).requestIds, ['b']);
  const late = await h.event(request('a', 'store-a')); assert.equal(late.body.duplicate, true);
});

test('supersession and delayed starts are scoped to the requesting store', async t => {
  const h = await setup(t); await h.event(request('a1', 'store-a')); await h.event(request('b1', 'store-b'));
  h.time = start + 12000; await h.event(request('a2', 'store-a', start + 12000));
  await h.event(close('a1', 'store-a', start + 12000));
  assert.equal((await h.event(request('a-late', 'store-a', start + 6000))).body.superseded, true);
  assert.deepEqual(new Set((await h.due()).requestIds), new Set(['a2','b1']));
});

test('close-before-open tombstone for one store does not block another store on the same account', async t => {
  const h = await setup(t); await h.event(close('a', 'store-a')); await h.restart();
  assert.equal((await h.event(request('a', 'store-a'))).body.closed, true);
  assert.equal((await h.event(request('b', 'store-b'))).status, 202);
  assert.deepEqual((await h.due()).requestIds, ['b']);
});

test('one newest email POST satisfies every fitting displayed store with no assignedStoreId', async t => {
  const h = await setup(t); await h.event(request('a', 'store-a'));
  h.time = start + 6000; await h.event(request('b', 'store-b', start + 6000));
  h.time = start + 10000;
  await h.batch([message('older', start), message('newest', start + 1000)], ['a','b']);
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].body.requestId, 'a');
  assert.equal(h.posts[0].body.receivedAt, new Date(start + 1000).toISOString());
  assert.equal((await h.due()).boosted, false);
  assert.equal((await h.process(message('newest', start + 1000))).body.status, 'already_delivered');
  const disk = JSON.parse(await readFile(h.options.statePath, 'utf8'));
  assert.equal(disk.lastDeliveryResult.displayedStoreCount, 2);
});

test('displayed is request-specific: a different displayed store cannot stop the requesting store', async t => {
  const h = await setup(t); await h.event(request('a', 'store-a'));
  h.time = start + 6000; await h.event(request('b', 'store-b', start + 6000)); h.shown = ['store-b'];
  assert.equal((await h.process(message('only-b', start + 6000))).body.status, 'stored_not_displayed');
  assert.deepEqual((await h.due()).requestIds, ['a']);
});

test('an undisplayed holder keeps watching and a same-code new email can satisfy it later', async t => {
  const h = await setup(t); await h.event(request('a', 'store-a'));
  h.time = start + 6000; await h.event(request('b', 'store-b', start + 6000)); h.shown = ['store-a'];
  await h.process(message('first-email', start + 6000));
  assert.deepEqual((await h.due()).requestIds, ['b']);
  h.time = start + 7000; h.shown = ['store-b'];
  await h.process(message('second-email', start + 7000));
  assert.equal((await h.due()).boosted, false); assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].body.requestId, 'b'); assert.equal(h.posts[0].body.code, h.posts[1].body.code); assert.notEqual(h.posts[0].key, h.posts[1].key);
});

test('closed selected request stops independently while a displayed other holder is fulfilled', async t => {
  const h = await setup(t, body => ({ request: { id: body.requestId, status: 'closed' } }));
  await h.event(request('a', 'store-a')); h.time = start + 6000; await h.event(request('b', 'store-b', start + 6000)); h.shown = ['store-b'];
  assert.equal((await h.process(message('close-result', start + 6000))).body.status, 'request_closed');
  assert.equal((await h.due()).boosted, false); assert.equal(h.posts.length, 1);
});

test('freshness and timeout remain independent for each request on a shared account', async t => {
  const h = await setup(t); await h.event(request('a', 'store-a'));
  h.time = start + 120000; await h.event(request('b', 'store-b', start + 120000)); h.shown = ['store-a'];
  await h.process(message('too-old-for-b', start + 1000));
  assert.deepEqual((await h.due()).requestIds, ['b']);
  h.time = start + TTL; assert.equal((await h.due()).boosted, true);
  h.time = start + TTL + 120000; assert.equal((await h.due()).boosted, false);
});

test('captured old scan cannot be rebound to the other or superseding request', async t => {
  const h = await setup(t); await h.event(request('a1', 'store-a')); await h.event(close('a1', 'store-a'));
  h.time = start + 6000; await h.event(request('b', 'store-b', start + 6000)); await h.event(request('a2', 'store-a', start + 6000));
  assert.equal((await h.process(message('stale-scan', start + 6000), ['a1'])).body.status, 'superseded_scan');
  assert.equal(h.posts.length, 0);
});

test('current directory eligibility is rechecked before delivery without trusting a primary', async t => {
  const h = await setup(t); await h.event(request('b', 'store-b'));
  h.account = { ...shared(), assignedStoreId: 'store-a', eligibleStoreIds: ['store-a'] }; h.shown = ['store-a'];
  assert.equal((await h.process(message('removed-holder'))).body.status, 'unmatched_or_ambiguous_account');
  assert.equal(h.posts.length, 0);
});

test('malformed shared replies do not become successful deliveries', async t => {
  for (const extra of [
    { eligibleStoreIds: undefined }, { displayedStoreIds: undefined },
    { displayedStoreIds: ['outside-store'] }, { displayedStoreIds: ['store-b'], displayed: true },
  ]) {
    const h = await setup(t, () => extra); await h.event(request('a', 'store-a'));
    assert.equal((await h.process(message('bad-reply'))).body.status, 'invalid_delivery_response');
    assert.equal((await h.due()).boosted, true);
  }
});

test('newest watermarks are per request and another holder cannot close a watch waiting for newer mail', async t => {
  let fail = true;
  const h = await setup(t, () => { if (fail) { fail = false; throw new Error('synthetic failure'); } return {}; });
  await h.event(request('a', 'store-a')); h.time = start + 20000;
  assert.equal((await h.process(message('newer', start + 10000), ['a'])).body.status, 'fielddesk_unavailable');
  await h.event(request('b', 'store-b', start + 1000)); h.shown = ['store-a','store-b'];
  await h.process(message('older-for-b', start + 1000), ['b']);
  assert.deepEqual((await h.due()).requestIds, ['a']);
  h.shown = ['store-a']; assert.equal((await h.process(message('newer', start + 10000), ['a'])).body.status, 'delivered');
  assert.equal(h.posts[0].key, h.posts[2].key);
});

test('migration preserves an account-keyed PR #21 watch and adds another holder without replacing it', async t => {
  const h = await setup(t);
  await writeFile(h.options.statePath, JSON.stringify({ delivered: {}, events: {}, polls: {}, issues: [], boosts: { [digest('shared_account')]: { username: 'shared_account', requestId: 'a-old', storeId: 'store-a', requestedAt: start, acceptFrom: start - 60000, until: start + TTL, lastPoll: 0, correlated: true } } }));
  await h.restart(); await h.event(request('b', 'store-b'));
  const due = await h.due(); assert.deepEqual(new Set(due.requestIds), new Set(['a-old','b']));
  await h.event(close('a-old', 'store-a')); h.time = start + 15000;
  assert.deepEqual((await h.due()).requestIds, ['b']);
  const disk = await readFile(h.options.statePath, 'utf8');
  assert.equal(JSON.parse(disk).lookupSchemaVersion, 2); assert.ok(!disk.includes('A1B2C')); assert.ok(!disk.includes(secret));
});

test('a Download request remains eligible when another holder is the primary Play store', async t => {
  const h = await setup(t);
  h.account = { ...shared(), assignedStoreId: 'store-a', holders: [{ storeId: 'store-a', purpose: 'play', date: '2026-10-31' }, { storeId: 'store-b', purpose: 'download', date: '2026-10-31' }] };
  await h.event(request('download-b', 'store-b'));
  assert.equal((await h.process(message('mixed-purpose'))).body.status, 'delivered');
  assert.equal(h.posts[0].body.requestId, 'download-b'); assert.equal((await h.due()).boosted, false);
});

test('shared Download lookups still accept owner-trusted forwarded Spam with duplicate display addresses', async t => {
  const h = await setup(t);
  const service = await createService({ ...h.options, mailboxes: [{ ...boxes[0], allowRequestedRedirects: true, trustedForwarders: ['relay@example.invalid'] }] });
  for (const [id, store] of [['a','store-a'],['b','store-b']]) {
    h.requests.set(id, { storeId: store, status: 'open' });
    await service.webhook(...signed(request(id, store)));
  }
  const forwarded = message('shared-forward');
  forwarded.payload.headers.push({ name: 'To', value: '"relay@example.invalid" <relay@example.invalid>' });
  forwarded.payload.headers.find(h => h.name === 'Authentication-Results').value = 'mx.google.com; dmarc=fail header.from=steampowered.com; arc=pass';
  const result = await service.processBatch({ mailbox: boxes[0].id, provider: 'gmail', messages: [forwarded], requestIds: ['a','b'] });
  assert.equal(result.body.results[0].status, 'delivered'); assert.equal(h.posts.length, 1);
  assert.equal((await service.due(boxes[0].id)).body.boosted, false);
});

test('shared-download HTTP mock accepts a null primary and one POST displays both fitting holders', async t => {
  const h = await setup(t), lookups = new Map([['a','store-a'],['b','store-b']]);
  const mock = createServer({ apiKey: 'synthetic-api', now: () => start, accounts: [shared()], lookupStatus: id => lookups.has(id) ? 'open' : 'unknown', lookupStore: id => lookups.get(id), isDisplayed: () => true });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => mock.close(resolve)));
  let posts = 0;
  const service = await createService({ ...h.options, baseUrl: `http://127.0.0.1:${mock.address().port}/api/v1`, fetchImpl: async (url, init) => { if (url.endsWith('/steam/otp')) posts++; return fetch(url, init); } });
  await service.webhook(...signed(request('a','store-a'))); await service.webhook(...signed(request('b','store-b')));
  const outcome = await service.processBatch({ mailbox: boxes[0].id, provider: 'gmail', messages: [message('shared-http')], requestIds: ['a','b'] });
  assert.equal(outcome.body.results[0].status, 'delivered'); assert.equal(posts, 1);
  assert.equal((await service.due(boxes[0].id)).body.boosted, false);
});

test('idempotent shared replies recompute holders and request-store display without changing expiry', async t => {
  const account = shared(), lookups = new Map([['a','store-a'],['b','store-b']]);
  const mock = createServer({ apiKey: 'synthetic-api', now: () => start, accounts: [account], lookupStatus: () => 'open', lookupStore: id => lookups.get(id), isDisplayed: (_name, _at, store) => store === 'store-b' });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => mock.close(resolve)));
  const post = requestId => fetch(`http://127.0.0.1:${mock.address().port}/api/v1/steam/otp`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-api', 'Content-Type': 'application/json', 'Idempotency-Key': 'same-email' }, body: JSON.stringify({ accountUsername: account.username, code: 'A1B2C', receivedAt: new Date(start).toISOString(), requestId }) });
  const a = await (await post('a')).json(); assert.equal(a.assignedStoreId, null); assert.equal(a.displayed, false); assert.deepEqual(a.displayedStoreIds, ['store-b']);
  const b = await (await post('b')).json(); assert.equal(b.duplicate, true); assert.equal(b.displayed, true); assert.equal(b.request.status, 'open'); assert.equal(b.expiresAt, a.expiresAt);
  account.eligibleStoreIds = []; const gone = await (await post('b')).json();
  assert.deepEqual(gone.eligibleStoreIds, []); assert.deepEqual(gone.displayedStoreIds, []); assert.equal(gone.request.status, 'unknown');
});
