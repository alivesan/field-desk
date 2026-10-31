/*
 * What HQ sees of the Toornament result queue, the pure half (src/lib/toornament-queue.ts): codes in plain words, "A beat B",
 * the order of the page, the counts on a store's panel, and the matches a store's setup can't send. Synthetic data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, type CommandContext } from '../src/lib/commands.ts';
import { codeText, countsLine, jobMatchTitle, jobWhat, needsHq, queueCounts, sortQueue, STATE_TEXT, unsendableMatches, type QueueJob, type QueueState } from '../src/lib/toornament-queue.ts';
import type { Match, Player, Store } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const job = (over: Partial<QueueJob> = {}): QueueJob => ({
  id: 'tj_1',
  storeId: 's1',
  entityId: 'load-1-0-0',
  revision: 1,
  kind: 'match.result',
  state: 'pending',
  attempt: 0,
  code: 'created',
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  history: [],
  toornamentLabel: 'Match #1.1.1.1',
  participants: ['Asha', 'Dev'],
  desired: { outcome: 'played', winnerName: 'Asha' },
  ...over,
});
const STATES: QueueState[] = ['pending', 'claimed', 'done', 'failed', 'needs-human', 'cancelled'];

test('codes in plain words; a code nobody knows is shown as it is; nothing for none', () => {
  for (const c of ['VERIFIED', 'UNCERTAIN_EFFECT', 'REVIEW_REQUIRED', 'superseded', 'lease-expired-after-checkpoint', 'lease-expired', 'too-many-attempts', 'resolved-by-hq', 'retry-by-hq']) {
    const t = codeText(c);
    assert.notEqual(t, c, c);
    assert.ok(t.length > 10 && t[0] === t[0].toUpperCase(), c);
  }
  assert.match(codeText('lease-expired-after-checkpoint'), /may or may not have saved/);
  assert.match(codeText('UNCERTAIN_EFFECT'), /check Toornament/);
  assert.equal(codeText('wrong-tournament'), 'wrong-tournament');
  assert.equal(codeText('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.equal(codeText(null), '');
  assert.equal(codeText(''), '');
});

test('state words and who they are for', () => {
  assert.deepEqual(
    STATES.map((s) => STATE_TEXT[s]),
    ['waiting', 'working', 'done', 'failed', 'needs you', 'cancelled'],
  );
  assert.deepEqual(STATES.filter(needsHq), ['failed', 'needs-human']);
});

test('what a job does: A beat B, B wins by forfeit, Reset', () => {
  assert.equal(jobWhat(job()), 'Asha beat Dev');
  assert.equal(jobWhat(job({ desired: { outcome: 'played', winnerName: 'Dev' } })), 'Dev beat Asha');
  assert.equal(jobWhat(job({ desired: { outcome: 'forfeit', winnerName: 'Dev' } })), 'Dev wins by forfeit');
  assert.equal(jobWhat(job({ kind: 'match.reset', desired: null })), 'Reset');
});

test('the match line: the desk number and Toornament’s; Toornament’s alone when the match is gone', () => {
  const m = (id: string, round: number, index: number) => ({ id, round, index, a: null, b: null, winner: null, status: 'pending', score: '' }) as Match;
  const matches = [m('x-0-0', 0, 0), m('x-0-1', 0, 1), m('x-1-0', 1, 0)];
  assert.equal(jobMatchTitle(job({ entityId: 'x-1-0', toornamentLabel: 'Match #1.1.2.1' }), matches), 'M3 · #1.1.2.1');
  assert.equal(jobMatchTitle(job({ entityId: 'gone', toornamentLabel: 'Match #1.1.2.1' }), matches), '#1.1.2.1');
  assert.equal(jobMatchTitle(job({ entityId: 'x-0-1', toornamentLabel: 'Match #1.1.1.2' }), undefined), '#1.1.1.2');
});

test('the order: what needs HQ, then waiting and working, then the rest — newest first inside each', () => {
  const at = (n: number) => `2026-10-24T10:0${n}:00.000Z`;
  const sorted = sortQueue([
    job({ id: 'done-new', state: 'done', updatedAt: at(9) }),
    job({ id: 'wait-old', state: 'pending', updatedAt: at(1) }),
    job({ id: 'fail-old', state: 'failed', updatedAt: at(2) }),
    job({ id: 'human-new', state: 'needs-human', updatedAt: at(5) }),
    job({ id: 'work', state: 'claimed', updatedAt: at(6) }),
    job({ id: 'cancelled', state: 'cancelled', updatedAt: at(3) }),
  ]);
  assert.deepEqual(
    sorted.map((j) => j.id),
    ['human-new', 'fail-old', 'work', 'wait-old', 'done-new', 'cancelled'],
  );
});

test('the counts: waiting (waiting + working), needs you (needs you + failed), done on that day only', () => {
  const day = (iso: string) => iso.slice(0, 10); // the test's own "local" day
  const c = queueCounts(
    [
      job({ state: 'pending' }),
      job({ state: 'claimed' }),
      job({ state: 'needs-human' }),
      job({ state: 'failed' }),
      job({ state: 'failed' }),
      job({ state: 'done', updatedAt: '2026-10-24T08:00:00.000Z' }),
      job({ state: 'done', updatedAt: '2026-10-23T08:00:00.000Z' }),
      job({ state: 'cancelled' }),
    ],
    '2026-10-24',
    day,
  );
  assert.deepEqual(c, { waiting: 2, needsYou: 3, doneToday: 1 });
  assert.equal(countsLine(c), '2 waiting · 3 need you · 1 done today');
  assert.equal(countsLine({ waiting: 0, needsYou: 1, doneToday: 0 }), '1 needs you');
  assert.equal(countsLine({ waiting: 0, needsYou: 0, doneToday: 0 }), 'Nothing sent yet.');
});

/* ---------- the matches the queue can't cover ---------- */

const event = fixtureEvent('e1') as any;
const ctx: CommandContext = { commandId: 'load-1', now: '2026-10-24T10:00:00.000Z', actor: { principal: 'super', name: 'HQ', role: 'super' }, event };
const players: Player[] = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `P${n}`, seed: n, toornamentId: String(1000 + n) }));
const nodes = [
  { round: 0, index: 0, id: '333', label: '1.1.1.1' },
  { round: 0, index: 1, id: '334', label: '1.1.1.2' },
  { round: 1, index: 0, id: '335', label: '1.1.2.1' },
];
function ready(over: { sync?: boolean; players?: Player[] } = {}): Store {
  let store = fixtureStore('s1', 'e1', null) as unknown as Store;
  store.toornament = { url: 'https://play.toornament.com/en_US/tournaments/111/stages/222/', stageId: '222', ...(over.sync === false ? {} : { sync: { on: true } }) };
  store = applyCommand(store, { type: 'bracket.load', base: 0, players: over.players ?? players, toornament: nodes }, ctx);
  store.toornament!.loadId = 'load-1';
  return store;
}

test('unsendable: nothing when all is in place (the final still waits for its players, which is not a problem), nothing when sync is off', () => {
  assert.deepEqual(unsendableMatches(ready()), []);
  assert.deepEqual(unsendableMatches(ready({ sync: false })), []);
});

test('unsendable: a player without a Toornament id names the match with both numbers and the reason in words', () => {
  const noId = players.map((p) => (p.id === 'p1' ? { ...p, toornamentId: undefined } : p)) as Player[];
  const list = unsendableMatches(ready({ players: noId }));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'M1 · #1.1.1.1');
  assert.equal(list[0].reason, 'not-mapped:no-participant-id');
  assert.match(list[0].text, /not matched to a Toornament participant/);
});

test('unsendable: a store-level problem lists every match (the store-level checks come before the players)', () => {
  const store = ready();
  delete store.toornament!.stageId;
  const list = unsendableMatches(store);
  assert.deepEqual(
    list.map((u) => [u.title, u.reason]),
    [
      ['M1 · #1.1.1.1', 'not-mapped:no-stage'],
      ['M2 · #1.1.1.2', 'not-mapped:no-stage'],
      ['M3 · #1.1.2.1', 'not-mapped:no-stage'],
    ],
  );
});
