import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { createServer } from '../mock/server.mjs';

const startTime = Date.parse('2026-10-25T12:00:00.000Z');
let currentTime = startTime;
const server = createServer({ apiKey: 'demo-secret', now: () => currentTime });

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const incoming = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    incoming.method = method;
    incoming.url = path;
    incoming.headers = headers;
    const response = {
      destroyed: false,
      status: 200,
      headers: {},
      writeHead(status, nextHeaders) { this.status = status; this.headers = nextHeaders; },
      end(data = '') {
        const content = String(data);
        resolve({ status: this.status, headers: this.headers, json: async () => JSON.parse(content), text: async () => content });
      },
    };
    server.emit('request', incoming, response);
  });
}

function otp(body, headers = {}) {
  return request('/api/v1/steam/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-secret', ...headers },
    body: JSON.stringify(body),
  });
}

test('API key is mandatory and health/accounts expose only synthetic data', async () => {
  assert.throws(() => createServer({ apiKey: '' }), /FD_API_KEY/);
  const health = await request('/health');
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await request('/api/v1/steam/accounts')).status, 401);
  const accounts = await (await request('/api/v1/steam/accounts', { headers: { authorization: 'Bearer demo-secret' } })).json();
  assert.deepEqual(accounts.map(({ username }) => username), ['store_alpha', 'store_beta']);
  assert.deepEqual(accounts.map(({ email }) => email), ['login-alpha@example.invalid', 'login-beta@example.invalid']);
  for (const account of accounts) {
    assert.equal(typeof account.assignedStoreId, 'string');
    assert.equal(typeof account.purpose, 'string');
  }
  const unauthorized = await request('/api/v1/steam/otp', { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
});

test('valid code appears only in local HTML store and expires from receivedAt', async () => {
  const receivedAt = new Date(startTime - 1000).toISOString();
  const accepted = await otp({ accountUsername: 'store_alpha', code: 'A1B2C', receivedAt });
  assert.equal(accepted.status, 200);
  const result = await accepted.json();
  assert.equal(result.expiresAt, new Date(startTime - 1000 + 600000).toISOString());
  assert.equal(JSON.stringify(result).includes('A1B2C'), false);

  const cards = await (await request('/mock/cards')).json();
  assert.equal(cards.cards[0].active, true);
  assert.equal(JSON.stringify(cards).includes('A1B2C'), false);
  const store = await (await request('/mock/store')).text();
  assert.match(store, /A1B2C/);
  assert.match(store, /store_alpha/);

  currentTime = startTime + 600000;
  const expiredCards = await (await request('/mock/cards')).json();
  assert.equal(expiredCards.cards[0].active, false);
  const expiredStore = await (await request('/mock/store')).text();
  assert.doesNotMatch(expiredStore, /A1B2C/);
  currentTime = startTime;
});

test('rejects invalid account, code, and timestamps', async () => {
  const valid = { accountEmail: 'login-beta@example.invalid', code: 'Z9Y8X', receivedAt: new Date(startTime).toISOString() };
  const badBodies = [
    { ...valid, accountEmail: 'nobody@example.invalid' },
    { ...valid, accountUsername: 'store_alpha' },
    { ...valid, code: 'abc12' },
    { ...valid, code: 'ABC123' },
    { ...valid, receivedAt: new Date(startTime - 600001).toISOString() },
    { ...valid, receivedAt: new Date(startTime - 600000).toISOString() },
    { ...valid, receivedAt: new Date(startTime + 30001).toISOString() },
    { ...valid, receivedAt: 'invalid' },
  ];
  for (const body of badBodies) assert.equal((await otp(body)).status, 400);
  assert.equal((await otp(valid)).status, 200);
});

test('older data cannot overwrite and idempotency keys replay one request only', async () => {
  const receivedAt = new Date(startTime + 1000).toISOString();
  const first = { accountUsername: 'store_alpha', code: 'Q1W2E', receivedAt };
  assert.equal((await otp(first, { 'Idempotency-Key': 'delivery-1' })).status, 200);
  assert.equal((await otp(first, { 'Idempotency-Key': 'delivery-1' })).status, 200);
  assert.equal((await otp({ ...first, code: 'R3T4Y' }, { 'Idempotency-Key': 'delivery-1' })).status, 409);
  assert.equal((await otp({ ...first, code: 'R3T4Y' })).status, 409);
  assert.equal((await otp({ ...first, receivedAt: new Date(startTime).toISOString(), code: 'U5I6O' })).status, 409);
  const store = await (await request('/mock/store')).text();
  assert.match(store, /Q1W2E/);
  assert.doesNotMatch(store, /R3T4Y/);
});
