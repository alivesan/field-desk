// Read-only Field Desk check and n8n signature probes; never submits an OTP.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
assert.equal(process.env.FIELD_DESK_BASE_URL, 'https://fieldesk.runs-at.dev/api/v1');
const webhook = 'http://10.0.0.230:5678/webhook/steam-request';
const health = await fetch('http://10.0.0.230:5678/healthz', { signal: AbortSignal.timeout(10_000) });
assert.equal(health.status, 200);
console.log('PASS: private-IP health 200.');
const post = (body, signature) => fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-FieldDesk-Signature': signature } : {}) }, body, signal: AbortSignal.timeout(20_000) });
assert.equal((await post('{}')).status, 401);
console.log('PASS: unsigned webhook rejected (401).');
const incomplete = JSON.stringify({ type: 'steam.otp.requested', at: new Date().toISOString() });
const signature = `sha256=${createHmac('sha256', process.env.FD_WEBHOOK_SECRET).update(incomplete).digest('hex')}`;
assert.equal((await post(incomplete, signature)).status, 400);
console.log('PASS: correctly signed malformed event rejected (400).');
assert.equal((await post(incomplete + ' ', signature)).status, 401);
console.log('PASS: private-IP health 200; unsigned 401; correctly signed malformed event 400; modified bytes 401.');
const response = await fetch(`${process.env.FIELD_DESK_BASE_URL}/steam/accounts`, { headers: { Authorization: `Bearer ${process.env.FD_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
console.log(`Field Desk accounts authentication status: ${response.status}.`);
if (response.ok) {
  const accounts = await response.json(); assert.ok(Array.isArray(accounts));
  const account = accounts.find(item => item.assignedStoreId && /^[a-zA-Z0-9_]{1,64}$/.test(item.username || ''));
  if (account) {
    const event = JSON.stringify({ id: `readiness-${randomUUID()}`, type: 'steam.otp.requested', at: new Date().toISOString(), accountUsername: account.username });
    const sig = `sha256=${createHmac('sha256', process.env.FD_WEBHOOK_SECRET).update(event).digest('hex')}`;
    assert.equal((await post(event, sig)).status, 202);
    assert.equal((await post(event, sig)).status, 200);
    console.log('PASS: authenticated directory read and accepted/deduplicated polling hint. No OTP submitted.');
  } else console.log('API authentication works; no assigned account is available for a polling hint test.');
} else if (response.status === 401 || response.status === 503) {
  console.log('Pending private key installation on Field Desk. Transport/signature checks passed; full acceptance is not yet verified.');
} else throw new Error('Unexpected Field Desk API status; no response body or secrets displayed.');
