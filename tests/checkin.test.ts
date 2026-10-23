/*
 * Player self check-in: tokens, the "joined" notices, admin edits, and the public page's messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64url,
  checkInUrl,
  closeSelfCheckIn,
  matchesPlayer,
  newCheckInToken,
  newSelfCheckIns,
  openSelfCheckIn,
  problemFor,
  problemText,
  recentSelfCheckIns,
  retryAfterSeconds,
  rotateSelfCheckIn,
  staffCheckIn,
  TOKEN_RE,
  undoCheckIn,
  withoutPhone,
} from '../src/lib/checkin.ts';
import { qrShape } from '../src/lib/qr.ts';
import { maskPhone, publicName } from '../src/lib/phone.ts';
import type { MatchDay } from '../src/lib/types.ts';

const day = (over: Partial<MatchDay> = {}): MatchDay => ({
  players: [
    { id: 'pa', name: 'Aarav Shah', seed: 1, phone: '9820011111' },
    { id: 'pb', name: 'Meera Nair', seed: 2, phone: '9820022222' },
    { id: 'pc', name: 'Kabir Singh', seed: 3 },
  ],
  checkIn: {},
  matches: [],
  stations: 2,
  ...over,
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('newCheckInToken: url-safe, 24 chars (18 random bytes), matches the router pattern, no repeats', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = newCheckInToken();
    assert.match(t, TOKEN_RE);
    assert.equal(t.length, 24);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
  // asks for at least 16 bytes of randomness
  let asked = 0;
  newCheckInToken((n) => ((asked = n), new Uint8Array(n)));
  assert.ok(asked >= 16);
  // the router in src/main.tsx accepts it
  assert.ok(`/c/${newCheckInToken()}`.match(/^\/c\/([A-Za-z0-9_-]{16,64})\/?$/));
});

test('base64url encodes like the standard alphabet, without padding', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10, 0x83, 0x61]);
  const std = Buffer.from(bytes).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(base64url(bytes), std);
  assert.equal(base64url(new Uint8Array(18)), 'A'.repeat(24));
  assert.equal(checkInUrl('https://desk.example/', 'abc'), 'https://desk.example/c/abc');
});

test('open / close / rotate: token made once, kept on reopen, replaced on New QR', () => {
  const d = day();
  let n = 0;
  const tok = () => `token-${++n}-aaaaaaaaaaaa`;
  openSelfCheckIn(d, '2026-10-23T10:00:00.000Z', tok);
  assert.deepEqual(d.selfCheckIn, { token: 'token-1-aaaaaaaaaaaa', open: true, openedAt: '2026-10-23T10:00:00.000Z' });
  closeSelfCheckIn(d);
  assert.equal(d.selfCheckIn!.open, false);
  openSelfCheckIn(d, '2026-10-23T11:00:00.000Z', tok);
  assert.equal(d.selfCheckIn!.token, 'token-1-aaaaaaaaaaaa');
  assert.equal(d.selfCheckIn!.openedAt, '2026-10-23T11:00:00.000Z');
  rotateSelfCheckIn(d, tok);
  assert.equal(d.selfCheckIn!.token, 'token-2-aaaaaaaaaaaa');
  assert.equal(d.selfCheckIn!.open, true);
  // nothing to close or rotate before the first open
  const e = day();
  closeSelfCheckIn(e);
  rotateSelfCheckIn(e, tok);
  assert.equal(e.selfCheckIn, undefined);
});

test('newSelfCheckIns: only new self entries; ignores staff, the first snapshot and re-renders', () => {
  const a = day({ checkIn: { pb: '2026-10-23T10:00:00.000Z' }, checkInSource: { pb: 'self' } });
  assert.deepEqual(newSelfCheckIns(undefined, a), [], 'first render replays nothing');
  assert.deepEqual(newSelfCheckIns(a, clone(a)), [], 're-render with equal data');

  const b = clone(a);
  b.checkIn.pa = '2026-10-23T10:05:00.000Z';
  b.checkInSource!.pa = 'self';
  b.checkIn.pc = '2026-10-23T10:04:00.000Z'; // staff, no source entry
  assert.deepEqual(newSelfCheckIns(a, b), [{ pid: 'pa', at: '2026-10-23T10:05:00.000Z' }]);

  const c = clone(b);
  c.checkIn.pc = '2026-10-23T10:06:00.000Z';
  c.checkInSource!.pc = 'staff';
  assert.deepEqual(newSelfCheckIns(b, c), [], 'staff check-in is not a notice');

  // undone, then the player checks in again by QR: new time → new notice
  const d = clone(c);
  undoCheckIn(d, 'pa');
  assert.deepEqual(newSelfCheckIns(c, d), []);
  const e = clone(d);
  e.checkIn.pa = '2026-10-23T10:09:00.000Z';
  e.checkInSource!.pa = 'self';
  assert.deepEqual(newSelfCheckIns(d, e), [{ pid: 'pa', at: '2026-10-23T10:09:00.000Z' }]);

  // a staff check-in later marked self (server overwrote) counts as new; several arrive oldest first
  const f = clone(e);
  f.checkInSource!.pc = 'self';
  f.checkIn.pb = '2026-10-23T10:01:00.000Z';
  assert.deepEqual(
    newSelfCheckIns(e, f).map((x) => x.pid),
    ['pb', 'pc'],
  );
});

test('recentSelfCheckIns: newest first, self only, limited', () => {
  const checkIn: Record<string, string> = {};
  const checkInSource: Record<string, 'self' | 'staff'> = {};
  for (let i = 0; i < 12; i++) {
    checkIn[`p${i}`] = `2026-10-23T10:${String(i).padStart(2, '0')}:00.000Z`;
    checkInSource[`p${i}`] = i % 4 === 3 ? 'staff' : 'self';
  }
  checkIn.px = '2026-10-23T11:00:00.000Z'; // checked in, no source = staff
  checkInSource.gone = 'self'; // source left behind without a check-in — not listed
  const r = recentSelfCheckIns(day({ checkIn, checkInSource }));
  assert.equal(r.length, 8);
  assert.deepEqual(
    r.map((x) => x.pid),
    ['p10', 'p9', 'p8', 'p6', 'p5', 'p4', 'p2', 'p1'],
  );
  assert.equal(recentSelfCheckIns(day({ checkIn, checkInSource }), 3).length, 3);
  assert.deepEqual(recentSelfCheckIns(day()), []);
});

test('staffCheckIn / undoCheckIn produce the right edits', () => {
  const d = day({ checkIn: { pa: '2026-10-23T10:00:00.000Z' }, checkInSource: { pa: 'self' } });
  undoCheckIn(d, 'pa');
  assert.deepEqual(d.checkIn, {});
  assert.deepEqual(d.checkInSource, {});

  staffCheckIn(d, 'pb', '2026-10-23T10:02:00.000Z');
  assert.deepEqual(d.checkIn, { pb: '2026-10-23T10:02:00.000Z' });
  assert.deepEqual(d.checkInSource, { pb: 'staff' });
  undoCheckIn(d, 'pb');
  assert.deepEqual(d, { ...day(), checkInSource: {} });

  // no source map yet: staff check-in leaves it absent (absent = staff) rather than creating it
  const e = day();
  staffCheckIn(e, 'pc', '2026-10-23T10:03:00.000Z');
  assert.equal(e.checkInSource, undefined);
  undoCheckIn(e, 'pc');
  assert.deepEqual(e, day());
});

test('roster helpers: phone search by digits, players without phones', () => {
  const [a, , c] = day().players;
  assert.ok(matchesPlayer(a, 'aarav'));
  assert.ok(matchesPlayer(a, '1111'));
  assert.ok(matchesPlayer(a, '98200 1'));
  assert.ok(!matchesPlayer(a, '22'), 'two digits are too few to search phones');
  assert.ok(!matchesPlayer(c, '1111'));
  assert.ok(!matchesPlayer(a, 'a1111'), 'mixed text is a name search');
  assert.ok(matchesPlayer(a, '  '));
  // in-game names are searched too (case-insensitive), digits in them included
  assert.ok(matchesPlayer({ ...a, ign: 'xX_Ark_Xx' }, 'ark'));
  assert.ok(matchesPlayer({ ...c, ign: 'Sn1per' }, 'sn1'));
  assert.ok(!matchesPlayer(a, 'ark'));
  assert.equal(withoutPhone(day().players), 1);
  assert.equal(maskPhone('9820011111'), '•••• •• 1111');
  assert.equal(publicName('Aarav  Shah'), 'Aarav S.');
});

test('public page: status/code → problem, Retry-After, messages never empty', () => {
  assert.equal(problemFor(403, 'closed'), 'closed');
  assert.equal(problemFor(404, 'no-match'), 'no-match');
  assert.equal(problemFor(404), 'no-match');
  assert.equal(problemFor(404, 'not-found'), 'not-found');
  assert.equal(problemFor(409, 'ambiguous'), 'ambiguous');
  assert.equal(problemFor(400, 'bad-request'), 'bad-request');
  assert.equal(problemFor(429), 'rate-limited');
  assert.equal(problemFor(500), 'server');
  assert.equal(retryAfterSeconds('12'), 12);
  assert.equal(retryAfterSeconds('0'), 1);
  assert.equal(retryAfterSeconds(null), 30);
  assert.equal(retryAfterSeconds('nonsense'), 30);
  assert.equal(retryAfterSeconds(new Date(Date.UTC(2026, 9, 23, 10, 1)).toUTCString(), Date.UTC(2026, 9, 23, 10, 0)), 60);
  assert.equal(retryAfterSeconds('99999'), 900);
  for (const p of ['closed', 'no-match', 'ambiguous', 'bad-request', 'rate-limited', 'offline', 'not-found', 'server'] as const) {
    const t = problemText(p, 20);
    assert.ok(t.title && t.body);
  }
  assert.match(problemText('rate-limited', 20).body, /20 seconds/);
});

test('qrShape: square with a quiet zone, path only inside it', () => {
  const url = checkInUrl('https://desk.example', newCheckInToken());
  const { size, path } = qrShape(url);
  assert.ok(size >= 21 + 8 && (size - 8 - 17) % 4 === 0, `QR versions are 17+4v modules (got ${size - 8})`);
  const nums = [...path.matchAll(/M(\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(nums.length > 20);
  for (const [x, y] of nums) assert.ok(x >= 4 && y >= 4 && x < size - 4 && y < size - 4);
  // top-left finder pattern: the first row starts with 7 dark modules at the quiet-zone corner
  assert.ok(path.startsWith('M4 4h7v1h-7z'));
});
