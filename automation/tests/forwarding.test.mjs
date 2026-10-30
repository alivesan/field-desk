import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseEmail, matchAccount, TTL } from '../worker/core.mjs';

const now = Date.parse('2026-10-25T07:00:00Z');
const accounts = [{ username: 'store_alpha', email: 'login-alpha@example.invalid', assignedStoreId: 'store-alpha' }];
const head = (name, value) => ({ name, value });
const utc = value => new Date(value).toUTCString();
function message({ from = 'Relay <relay@example.com>', auth = 'mx.google.com; dmarc=pass header.from=example.com', received = now, date = now, originalDate = now, originalFrom = 'Steam <noreply@steampowered.com>', content = 'Dear store_alpha,\nSteam Guard code is: A1B2C', html = false, extraHeaders = [] } = {}) {
  const forwarded = `---------- Forwarded message ---------\nFrom: ${originalFrom}\nDate: ${utc(originalDate)}\nSubject: Your Steam Guard code\nTo: login-alpha@example.invalid\n\n${content}`;
  const body = html ? `<div>---------- Forwarded message ---------</div><div>From: Steam &lt;noreply@steampowered.com&gt;</div><div>Date: ${utc(originalDate)}</div><div>Subject: Your Steam Guard code</div><div>To: login-alpha@example.invalid</div><br><div>Dear store_alpha,</div><div>Steam Guard code is: A1B2C</div>` : forwarded;
  return { id: 'forwarded-message', internalDate: String(received), payload: { mimeType: html ? 'text/html' : 'text/plain', headers: [
    head('From', from), head('To', 'central@example.invalid'), head('Date', utc(date)), head('Subject', 'Fwd: Your Steam Guard code'), head('Authentication-Results', auth), ...extraHeaders,
  ], body: { data: Buffer.from(body).toString('base64url') } } };
}
const parse = (input, trustedForwarders = ['relay@example.com']) => parseEmail(normalize('gmail', input), now, { trustedForwarders });
const quote = input => {
  input.payload.body.data = Buffer.from(Buffer.from(input.payload.body.data, 'base64url').toString('utf8').split('\n').map(line => `> ${line}`).join('\n')).toString('base64url');
  return input;
};

test('quoted forwarded headers and standalone code use the same normalized text', () => {
  const parsed = parse(quote(message({ content: 'Dear store_alpha,\nA1B2C' })));
  assert.equal(parsed.code, 'A1B2C');
  assert.equal(parsed.username, 'store_alpha');
});

test('code labels accept capitalization without accepting lowercase code payloads', () => {
  assert.equal(parse(message({ content: 'Dear store_alpha,\nYour Steam Guard Code IS: A1B2C' })).code, 'A1B2C');
  for (const code of ['a1b2c', 'A1b2C']) {
    assert.throws(() => parse(message({ content: `Dear store_alpha,\nYour Steam Guard Code IS: ${code}` })), /ambiguous_or_missing_code/);
    assert.throws(() => parse(quote(message({ content: `Dear store_alpha,\n${code}` }))), /ambiguous_or_missing_code/);
  }
});

test('different quoted codes remain ambiguous', () => {
  assert.throws(() => parse(quote(message({ content: 'Dear store_alpha,\nA1B2C\nD3E4F' }))), /ambiguous_or_missing_code/);
});

test('trusted central Gmail forward delivers the original Steam code and account name', () => {
  const parsed = parse(message());
  assert.equal(parsed.code, 'A1B2C');
  assert.equal(parsed.username, 'store_alpha');
  assert.equal(matchAccount(parsed, accounts).username, 'store_alpha');
  assert.equal(parsed.receivedAt, new Date(now).toISOString());
});

test('HTML forward decodes quoted angle brackets around original Steam From', () => {
  const parsed = parse(message({ html: true }));
  assert.equal(parsed.username, 'store_alpha');
  assert.equal(parsed.code, 'A1B2C');
});

test('forwarder allowlist and authoritative top-level authentication are mandatory', () => {
  assert.throws(() => parse(message(), []));
  assert.throws(() => parse(message({ from: 'Unknown <unknown@example.com>' })));
  assert.throws(() => parse(message({ auth: 'mx.google.com; dmarc=pass header.from=steampowered.com' })));
  assert.throws(() => parse(message({ auth: 'mx.bad.test; dmarc=pass header.from=example.com' })));
  assert.throws(() => parse(message({ extraHeaders: [head('Authentication-Results', 'mx.google.com; dmarc=pass header.from=example.com')] })));
  assert.throws(() => parse(message({ originalFrom: 'Attacker <attacker@example.com>' })));
});

test('old or future original and provider dates cannot refresh a forwarded code', () => {
  assert.throws(() => parse(message({ originalDate: now - TTL })));
  assert.throws(() => parse(message({ date: now - TTL })));
  assert.throws(() => parse(message({ received: now - TTL })));
  assert.throws(() => parse(message({ originalDate: now + 31_000 })));
  assert.throws(() => parse(message({ date: now + 31_000 })));
  assert.throws(() => parse(message({ received: now + 31_000 })));
  const absentDate = message(); absentDate.payload.headers = absentDate.payload.headers.filter(h => h.name !== 'Date');
  assert.throws(() => parse(absentDate));
  const noOriginalDate = message(); noOriginalDate.payload.body.data = Buffer.from('From: Steam <noreply@steampowered.com>\nDear store_alpha,\nSteam Guard code is: A1B2C').toString('base64url');
  assert.throws(() => parse(noOriginalDate), /original_date_unverified/);
  const ambiguousOriginal = message(); ambiguousOriginal.payload.body.data = Buffer.from('From: Steam <noreply@steampowered.com>\nDate: Sun, 25 Oct 2026 07:00:00 GMT\nDate: Sat, 24 Oct 2026 07:00:00 GMT\nDear store_alpha,\nSteam Guard code is: A1B2C').toString('base64url');
  assert.throws(() => parse(ambiguousOriginal), /original_date_unverified/);
});

test('forwarded email without a named account cannot fall back to recipient', () => {
  assert.throws(() => parse(message({ content: 'Steam Guard code is: A1B2C' })), /account_name_missing/);
});
