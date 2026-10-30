/*
 * What a store's Steam card may show (cardOtp, src/lib/steam.ts): the unexpired code, minus what the team has moved
 * past, filtered by the lookup it started last. Synthetic codes and times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOtp, LOOKUP_GRACE_MS, LOOKUP_WINDOW_MS, OTP_TTL_MS } from '../src/lib/steam.ts';

const NOW = Date.parse('2026-10-24T06:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const otp = (receivedMs: number, code = 'AB3DE') => ({ code, receivedAt: iso(receivedMs), expiresAt: iso(receivedMs + OTP_TTL_MS) });
const acct = (receivedMs: number, code?: string) => ({ otp: otp(receivedMs, code) });

test('no state at all: the unexpired code shows, as before', () => {
  assert.deepEqual(cardOtp(acct(NOW - 60_000), undefined, NOW), otp(NOW - 60_000));
  assert.deepEqual(cardOtp(acct(NOW - 60_000), {}, NOW), otp(NOW - 60_000));
});

test('no code, or an expired one: nothing — whatever the state says', () => {
  assert.equal(cardOtp(undefined, undefined, NOW), undefined);
  assert.equal(cardOtp({}, { lookup: { id: 'L', requestedAt: iso(NOW - 1000) } }, NOW), undefined);
  const gone = acct(NOW - OTP_TTL_MS);
  assert.equal(cardOtp(gone, undefined, NOW), undefined, 'expired exactly now');
  assert.equal(cardOtp(gone, { lookup: { id: 'L', requestedAt: iso(NOW - OTP_TTL_MS - 1000) } }, NOW), undefined);
  assert.deepEqual(cardOtp(gone, undefined, NOW - 1), otp(NOW - OTP_TTL_MS), 'a millisecond earlier it still lived');
});

test('seenThrough: that code and older never show; a newer one does', () => {
  const state = { seenThrough: iso(NOW - 120_000) };
  assert.equal(cardOtp(acct(NOW - 120_000), state, NOW), undefined, 'equal is hidden');
  assert.equal(cardOtp(acct(NOW - 150_000), state, NOW), undefined, 'older is hidden');
  assert.deepEqual(cardOtp(acct(NOW - 119_999), state, NOW), otp(NOW - 119_999));
  // it beats a lookup too
  const both = { seenThrough: iso(NOW - 30_000), lookup: { id: 'L', requestedAt: iso(NOW - 60_000) } };
  assert.equal(cardOtp(acct(NOW - 30_000), both, NOW), undefined);
  assert.deepEqual(cardOtp(acct(NOW - 29_000), both, NOW), otp(NOW - 29_000));
});

test('a lookup takes a code sent up to a minute before it: exactly -60 s is eligible, 1 ms earlier is not', () => {
  const requestedAt = NOW - 10_000;
  const state = { lookup: { id: 'L', requestedAt: iso(requestedAt) } };
  assert.equal(LOOKUP_GRACE_MS, 60_000);
  assert.deepEqual(cardOtp(acct(requestedAt - 60_000), state, NOW), otp(requestedAt - 60_000));
  assert.equal(cardOtp(acct(requestedAt - 60_001), state, NOW), undefined);
  assert.deepEqual(cardOtp(acct(requestedAt), state, NOW), otp(requestedAt), 'at the lookup');
  assert.deepEqual(cardOtp(acct(requestedAt + 5_000), state, NOW), otp(requestedAt + 5_000), 'after it');
});

test('a lookup keeps filtering after its ten minutes: a later code for a later sign-in still shows, an old one never comes back', () => {
  const requestedAt = NOW - LOOKUP_WINDOW_MS - 30_000; // its window ended half a minute ago
  const state = { lookup: { id: 'L', requestedAt: iso(requestedAt) } };
  assert.equal(LOOKUP_WINDOW_MS, 600_000);
  assert.deepEqual(cardOtp(acct(NOW - 60_000), state, NOW), otp(NOW - 60_000), 'sent after the window ended');
  assert.equal(cardOtp(acct(requestedAt - 120_000), state, NOW + 480_000), undefined, 'older than the grace: no');
});

test('dismissed: nothing shows until a lookup; a lookup brings back only what it takes', () => {
  const dismissed = { dismissedAt: iso(NOW - 5_000) };
  assert.equal(cardOtp(acct(NOW - 60_000), dismissed, NOW), undefined);
  assert.equal(cardOtp(acct(NOW - 1_000), dismissed, NOW), undefined, 'even a fresh one — the team has to start a lookup');
  // the next lookup replaces the dismissal (the server clears dismissedAt), and a fresh email shows
  const next = { lookup: { id: 'L2', requestedAt: iso(NOW) }, seenThrough: iso(NOW - 120_000) };
  assert.equal(cardOtp(acct(NOW - 120_000), next, NOW), undefined);
  assert.deepEqual(cardOtp(acct(NOW + 1_000), next, NOW + 2_000), otp(NOW + 1_000));
});

test('comparisons are in milliseconds, not text: another zone spelling of the same moment is the same moment', () => {
  const state = { seenThrough: '2026-10-24T11:28:00+05:30' }; // = 05:58:00Z
  assert.equal(cardOtp(acct(Date.parse('2026-10-24T05:58:00.000Z')), state, NOW), undefined);
  assert.deepEqual(cardOtp(acct(Date.parse('2026-10-24T05:58:01.000Z')), state, NOW), otp(Date.parse('2026-10-24T05:58:01.000Z')));
});
