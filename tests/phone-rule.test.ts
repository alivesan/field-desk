/*
 * The phone rule on the admin screens: a field admin sees a player's full number only once the
 * player is checked in (until then the device holds just `phoneEnd`); HQ always has it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPlayer, withoutPhone } from '../src/lib/checkin.ts';
import { maskedPhone, numberAccess, phoneTail, telFor } from '../src/lib/day-ui.ts';
import { onSpotClash } from '../src/lib/tournament.ts';
import type { MatchDay, Player } from '../src/lib/types.ts';

const full: Player = { id: 'a', name: 'Aarav Shah', seed: 1, phone: '9820011111' };
const hidden: Player = { id: 'b', name: 'Bela Rao', seed: 2, phoneEnd: '2222' }; // an admin's view of a player not checked in
const none: Player = { id: 'c', name: 'Chet Lal', seed: 3 };
const day = (players: Player[]): MatchDay => ({ players, checkIn: {}, matches: [], stations: 1 });

test('phoneTail / maskedPhone: from the full number or phoneEnd', () => {
  assert.equal(phoneTail(full), '1111');
  assert.equal(phoneTail(hidden), '2222');
  assert.equal(phoneTail(none), '');
  assert.equal(maskedPhone(full), '•••• •• 1111');
  assert.equal(maskedPhone(hidden), '•••• •• 2222');
  assert.equal(maskedPhone(none), '');
});

test('numberAccess: admins need the check-in, HQ does not', () => {
  // admin, not checked in: hidden even if the number is still on the device (an undo not synced yet)
  assert.equal(numberAccess(hidden, false, false), 'after-check-in');
  assert.equal(numberAccess(full, false, false), 'after-check-in');
  // admin, checked in: open once the number arrived, else loading
  assert.equal(numberAccess(full, true, false), 'open');
  assert.equal(numberAccess(hidden, true, false), 'loading');
  // no number at all
  assert.equal(numberAccess(none, false, false), 'none');
  assert.equal(numberAccess(none, true, false), 'none');
  // HQ
  assert.equal(numberAccess(full, false, true), 'open');
  assert.equal(numberAccess(full, true, true), 'open');
  assert.equal(numberAccess(none, true, true), 'none');
});

test('telFor: a Call link only when the rule lets this person see the number', () => {
  assert.equal(telFor(full, false, false), null);
  assert.equal(telFor(hidden, true, false), null);
  assert.equal(telFor(full, true, false), 'tel:+919820011111');
  assert.equal(telFor(full, false, true), 'tel:+919820011111');
  assert.equal(telFor(none, true, true), null);
});

test('search: last 4 digits find a player the device only holds phoneEnd for; full digits find a full number', () => {
  assert.equal(matchesPlayer(hidden, '2222'), true);
  assert.equal(matchesPlayer(hidden, '222'), true);
  assert.equal(matchesPlayer(hidden, '9820012222'), true); // a whole number ending in them
  assert.equal(matchesPlayer(hidden, '3333'), false);
  assert.equal(matchesPlayer(hidden, '9820011111'), false);
  assert.equal(matchesPlayer(full, '98200'), true); // checked in: any digits of the full number
  assert.equal(matchesPlayer(hidden, '98200'), false); // not checked in: the first digits aren't on the device
  assert.equal(matchesPlayer(hidden, '22'), false); // under 3 digits is not a phone search
  assert.equal(matchesPlayer(hidden, 'bela'), true);
});

test('withoutPhone: a player known only by phoneEnd has a number', () => {
  assert.equal(withoutPhone([full, hidden, none]), 1);
});

test('onSpotClash: full number is a hard clash; a last-4 match is only a soft one; a name clash wins over it', () => {
  const d = day([full, hidden, none]);
  assert.deepEqual(onSpotClash(d, 'Someone', '98200 11111'), { kind: 'phone', player: full });
  assert.deepEqual(onSpotClash(d, 'Someone', '+91 98765 42222'), { kind: 'phone-end', player: hidden });
  assert.equal(onSpotClash(d, 'Someone', '9876543333'), null);
  assert.deepEqual(onSpotClash(d, 'bela rao', '9876542222'), { kind: 'name', player: hidden });
  assert.equal(onSpotClash(d, 'Someone'), null); // no number typed: nothing to compare
});
