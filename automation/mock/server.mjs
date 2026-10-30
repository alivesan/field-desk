import http from 'node:http';
import { pathToFileURL } from 'node:url';

const TEN_MINUTES = 10 * 60 * 1000;
const FUTURE_ALLOWANCE = 30 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

export const ACCOUNTS = Object.freeze([
  Object.freeze({ username: 'store_alpha', email: 'login-alpha@example.invalid', assignedStoreId: 'store-alpha', purpose: 'Steam login OTP demo' }),
  Object.freeze({ username: 'store_beta', email: 'login-beta@example.invalid', assignedStoreId: 'store-beta', purpose: 'Steam login OTP demo' }),
]);

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function identifyAccount(body) {
  const { accountUsername, accountEmail } = body;
  if (typeof accountUsername !== 'string' && typeof accountEmail !== 'string') return null;
  const byUsername = accountUsername === undefined ? null : ACCOUNTS.find((account) => account.username === accountUsername);
  const byEmail = accountEmail === undefined ? null : ACCOUNTS.find((account) => account.email === accountEmail);
  if (accountUsername !== undefined && !byUsername) return null;
  if (accountEmail !== undefined && !byEmail) return null;
  if (byUsername && byEmail && byUsername !== byEmail) return null;
  return byUsername ?? byEmail;
}

function parseReceivedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return NaN;
  return Date.parse(value);
}

function renderStore(cards, now) {
  const entries = ACCOUNTS.map((account) => {
    const card = cards.get(account.username);
    const active = card && card.expiresAt > now;
    return `<article class="card"><h2>${escapeHtml(account.username)}</h2><p>${escapeHtml(account.email)}</p><p>Store: ${escapeHtml(account.assignedStoreId)}</p><p class="code">${active ? escapeHtml(card.code) : 'No active code'}</p>${active ? `<p>Expires: ${escapeHtml(new Date(card.expiresAt).toISOString())}</p>` : ''}</article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock Steam OTP store</title><style>body{font:16px system-ui,sans-serif;max-width:800px;margin:3rem auto;padding:0 1rem;background:#f6f7f9;color:#17212b}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem}.card{background:white;padding:1.25rem;border:1px solid #dce1e6;border-radius:12px}.code{font-size:2rem;font-weight:700;letter-spacing:.2em}</style></head><body><h1>Mock Steam OTP store</h1><p>Synthetic demo data only. Refresh to see current codes.</p><main class="cards">${entries}</main></body></html>`;
}

/** Create an in-memory demo server. Every instance has isolated card and idempotency state. */
export function createServer({ apiKey = process.env.FD_API_KEY, now = () => Date.now(), lookupStatus = () => 'unknown', isDisplayed = () => true } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('FD_API_KEY is required');
  const cards = new Map();
  const idempotency = new Map();
  const view = (result, body, account, currentTime) => {
    const card = cards.get(account.username);
    const status = body.requestId === undefined ? undefined : lookupStatus(body.requestId, account.username);
    return { ...result, displayed: Boolean(card && card.expiresAt > currentTime && card.receivedAt === Date.parse(result.receivedAt) && (status === undefined || status === 'open') && isDisplayed(account.username, card.receivedAt)),
      ...(status ? { request: { id: body.requestId, status } } : {}) };
  };

  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const currentTime = now();
    if (request.method === 'GET' && pathname === '/health') return json(response, 200, { ok: true });
    if (request.method === 'GET' && pathname === '/api/v1/steam/accounts') {
      if (request.headers.authorization !== `Bearer ${apiKey}`) return json(response, 401, { error: 'unauthorized' });
      return json(response, 200, ACCOUNTS);
    }
    if (request.method === 'GET' && pathname === '/mock/cards') {
      const safeCards = ACCOUNTS.map((account) => {
        const card = cards.get(account.username);
        return { accountUsername: account.username, accountEmail: account.email, assignedStoreId: account.assignedStoreId, active: Boolean(card && card.expiresAt > currentTime), receivedAt: card && card.expiresAt > currentTime ? new Date(card.receivedAt).toISOString() : null, expiresAt: card && card.expiresAt > currentTime ? new Date(card.expiresAt).toISOString() : null };
      });
      return json(response, 200, { cards: safeCards });
    }
    if (request.method === 'GET' && pathname === '/mock/store') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
      return response.end(renderStore(cards, currentTime));
    }
    if (request.method !== 'POST' || pathname !== '/api/v1/steam/otp') return json(response, 404, { error: 'not found' });

    if (request.headers.authorization !== `Bearer ${apiKey}`) return json(response, 401, { error: 'unauthorized' });
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      if (!response.destroyed) return json(response, error.status ?? 400, { error: error.status === 413 ? 'body too large' : 'invalid JSON' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(response, 400, { error: 'invalid body' });
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(body.requestId))) return json(response, 400, { error: 'invalid_request_id' });
    const account = identifyAccount(body);
    if (!account) return json(response, 400, { error: 'unknown or ambiguous account' });
    if (typeof body.code !== 'string' || !/^[A-Z0-9]{5}$/.test(body.code)) return json(response, 400, { error: 'invalid code' });
    const receivedAt = parseReceivedAt(body.receivedAt);
    if (!Number.isFinite(receivedAt)) return json(response, 400, { error: 'invalid receivedAt' });

    for (const [key, value] of idempotency) if (value.expiresAt <= currentTime) idempotency.delete(key);
    const idempotencyKey = request.headers['idempotency-key'];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))) return json(response, 400, { error: 'invalid Idempotency-Key' });
    const fingerprint = `${account.username}\0${body.code}\0${receivedAt}`;
    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      const previous = idempotency.get(idempotencyKey);
      if (previous.fingerprint !== fingerprint) return json(response, 409, { error: 'Idempotency-Key reused for different request' });
      return json(response, 200, view({ ...previous.result, duplicate: true }, body, account, currentTime));
    }
    if (receivedAt <= currentTime - TEN_MINUTES || receivedAt > currentTime + FUTURE_ALLOWANCE) return json(response, 400, { error: 'receivedAt outside allowed window' });

    const existing = cards.get(account.username);
    if (existing && receivedAt < existing.receivedAt) return json(response, 409, { error: 'older code cannot replace current code' });
    if (existing && receivedAt === existing.receivedAt && body.code !== existing.code) return json(response, 409, { error: 'conflicting code at same receivedAt' });
    const expiresAt = receivedAt + TEN_MINUTES;
    cards.set(account.username, { code: body.code, receivedAt, expiresAt });
    const result = { ok: true, accountUsername: account.username, accountEmail: account.email, assignedStoreId: account.assignedStoreId, receivedAt: new Date(receivedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
    if (idempotencyKey) idempotency.set(idempotencyKey, { fingerprint, result, expiresAt: currentTime + 48 * 3600_000 });
    return json(response, 200, view(result, body, account, currentTime));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8790);
  server.listen(port, host, () => {
    process.stdout.write(`Mock Steam OTP server listening on http://${host}:${port}\n`);
  });
}
