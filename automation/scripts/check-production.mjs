// Field Desk read and n8n signature probes. A polling hint requires explicit opt-in.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { eligibleStores } from '../worker/core.mjs';

export async function checkProduction({ env = process.env, fetchImpl = fetch, log = console.log, allowPending = false, sendPollingHint = false } = {}) {
  assert.equal(env.FIELD_DESK_BASE_URL, 'https://fieldesk.runs-at.dev/api/v1');
  const webhook = 'http://10.0.0.230:5678/webhook/steam-request';
  const health = await fetchImpl('http://10.0.0.230:5678/healthz', { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200);
  log('PASS: private-IP health 200.');
  const post = (body, signature) => fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-FieldDesk-Signature': signature } : {}) }, body, signal: AbortSignal.timeout(20_000) });
  assert.equal((await post('{}')).status, 401);
  log('PASS: unsigned webhook rejected (401).');
  const incomplete = JSON.stringify({ type: 'steam.otp.requested', at: new Date().toISOString() });
  const signature = `sha256=${createHmac('sha256', env.FD_WEBHOOK_SECRET).update(incomplete).digest('hex')}`;
  assert.equal((await post(incomplete, signature)).status, 400);
  log('PASS: correctly signed malformed event rejected (400).');
  assert.equal((await post(incomplete + ' ', signature)).status, 401);
  log('PASS: private-IP health 200; unsigned 401; correctly signed malformed event 400; modified bytes 401.');
  const response = await fetchImpl(`${env.FIELD_DESK_BASE_URL}/steam/accounts`, { headers: { Authorization: `Bearer ${env.FD_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
  log(`Field Desk accounts authentication status: ${response.status}.`);
  if (response.ok) {
    const accounts = await response.json(); assert.ok(Array.isArray(accounts));
    // An explicit test hint needs a single unambiguous target; shared holders
    // should use the real store's UI request rather than an arbitrary probe store.
    const account = accounts.find(item => eligibleStores(item).length === 1 && /^[a-zA-Z0-9_]{1,64}$/.test(item.username || ''));
    if (account && sendPollingHint) {
      const event = JSON.stringify({ id: `readiness-${randomUUID()}`, type: 'steam.otp.requested', at: new Date().toISOString(), accountUsername: account.username });
      const sig = `sha256=${createHmac('sha256', env.FD_WEBHOOK_SECRET).update(event).digest('hex')}`;
      assert.equal((await post(event, sig)).status, 202);
      assert.equal((await post(event, sig)).status, 200);
      log('PASS: authenticated directory read and accepted/deduplicated polling hint. An enabled mail workflow can deliver a real code for this request.');
    } else log('PASS: API authentication works. No polling hint sent.');
  } else if (response.status === 503 && allowPending) {
    log('PENDING: Field Desk is not configured (503). Bootstrap override enabled; full acceptance is not verified.');
    return { ready: false };
  } else if (response.status === 401 || response.status === 503) {
    throw new Error(`Field Desk API readiness failed (HTTP ${response.status}); verify private key installation and app configuration.`);
  } else throw new Error('Unexpected Field Desk API status; no response body or secrets displayed.');

  return { ready: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--allow-pending', '--poll-hint'].includes(arg))) {
    console.error('Usage: node check-production.mjs [--allow-pending] [--poll-hint]');
    process.exitCode = 1;
  } else {
    try { await checkProduction({ allowPending: args.includes('--allow-pending'), sendPollingHint: args.includes('--poll-hint') }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
