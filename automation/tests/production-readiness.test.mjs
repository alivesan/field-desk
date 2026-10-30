import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkProduction } from '../scripts/check-production.mjs';

// Dependency stubs only: importing and running these checks never opens a socket.
const env = { FIELD_DESK_BASE_URL: 'https://fieldesk.runs-at.dev/api/v1', FD_API_KEY: 'test-key', FD_WEBHOOK_SECRET: 'test-signing-secret' };
function harness(apiStatus, accounts = []) {
  const calls = [];
  const logs = [];
  const statuses = [200, 401, 400, 401, apiStatus];
  return { calls, logs, options: { env, log: message => logs.push(message), fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    assert.ok(statuses.length, 'unexpected request, including a synthetic polling hint');
    const status = statuses.shift();
    return { status, ok: status === 200, json: async () => accounts };
  } } };
}
for (const status of [401, 503]) {
  test(`production readiness rejects API ${status} by default`, async () => {
    const h = harness(status);
    await assert.rejects(checkProduction(h.options), new RegExp(`HTTP ${status}`));
    assert.equal(h.calls.length, 5);
    assert.equal(h.calls[4].options.headers.Authorization, 'Bearer test-key');
    assert.ok(h.calls.filter(call => call.options.method === 'POST').every(call => !JSON.parse(call.options.body).accountUsername));
    assert.ok(h.logs.every(message => !message.includes('test-key') && !message.includes('test-signing-secret')));
  });
}
test('bootstrap explicitly permits an unconfigured API but returns pending', async () => {
  const h = harness(503);
  assert.deepEqual(await checkProduction({ ...h.options, allowPending: true }), { ready: false });
  assert.ok(h.logs.some(message => message.startsWith('PENDING:')));
});
test('bootstrap override never hides rejected credentials', async () => {
  const h = harness(401);
  await assert.rejects(checkProduction({ ...h.options, allowPending: true }), /HTTP 401/);
});
test('authenticated empty directory is ready without sending a polling hint', async () => {
  const h = harness(200);
  assert.deepEqual(await checkProduction(h.options), { ready: true });
  assert.equal(h.calls.length, 5);
});

test('routine readiness does not trigger code lookup for an assigned account', async () => {
  const h = harness(200, [{ username: 'review_test_user', assignedStoreId: 'synthetic-store' }]);
  assert.deepEqual(await checkProduction(h.options), { ready: true });
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.filter(call => call.options.method === 'POST').every(call => !JSON.parse(call.options.body).accountUsername));
});
test('unexpected API failures fail readiness', async () => {
  const h = harness(500);
  await assert.rejects(checkProduction(h.options), /Unexpected Field Desk API status/);
});

test('assigned-account readiness signs and repeats the identical polling hint', async () => {
  const hints = [];
  const statuses = [200, 401, 400, 401, 200, 202, 200];
  const result = await checkProduction({ env, sendPollingHint: true, log: () => {}, fetchImpl: async (url, options = {}) => {
    assert.ok(statuses.length, 'unexpected extra readiness request');
    const status = statuses.shift();
    if (options.method === 'POST' && JSON.parse(options.body).accountUsername) {
      hints.push({ url, body: options.body, signature: options.headers['X-FieldDesk-Signature'] });
    }
    return { status, ok: status === 200, json: async () => [
      { username: 'unassigned', assignedStoreId: null },
      { username: 'review_test_user', assignedStoreId: 'synthetic-store' },
    ] };
  } });
  assert.deepEqual(result, { ready: true });
  assert.equal(statuses.length, 0);
  assert.equal(hints.length, 2);
  assert.deepEqual(hints[1], hints[0], 'duplicate must use identical URL, bytes and signature');
  assert.equal(hints[0].url, 'http://10.0.0.230:5678/webhook/steam-request');
  const event = JSON.parse(hints[0].body);
  assert.equal(event.accountUsername, 'review_test_user');
  assert.equal(event.type, 'steam.otp.requested');
  assert.match(event.id, /^readiness-[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(event.at)));
  assert.equal(hints[0].signature, `sha256=${createHmac('sha256', env.FD_WEBHOOK_SECRET).update(hints[0].body).digest('hex')}`);
});
