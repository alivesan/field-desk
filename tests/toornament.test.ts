/*
 * Toornament import (src/lib/toornament.ts) — links, stage types, the first round from
 * bracket-nodes (offline, from trimmed real answers in tests/fixtures/toornament/), matching
 * names onto a store's players, and the result going through the real bracket.load handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyToornamentLink,
  bracketFromNodes,
  isToornamentHost,
  labelsToAdd,
  parseToornamentLink,
  pickStage,
  planImport,
  sameFirstRound,
  readParticipants,
  readStages,
  readTournament,
  stageSupport,
  toornamentApi,
  toornamentLinkProblem,
} from '../src/lib/toornament.ts';
import { applyCommand, dayVersion, type CommandContext } from '../src/lib/commands.ts';
import { buildBracket } from '../src/lib/bracket.ts';
import { validateDocument } from '../src/lib/schema.ts';
import { playerIdFor } from '../src/lib/phone.ts';
import type { OnSpotEntry, Player, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureStore } from './helpers/server.ts';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/toornament/${name}.json`, import.meta.url), 'utf8'));
const first = (name: string) => {
  const f = fixture(name);
  const stages = readStages(f.stages);
  const participants = readParticipants(f.participants);
  const stage = pickStage(stages);
  return { f, stages, participants, stage, bracket: f.nodes ? bracketFromNodes(f.nodes.items, participants, stage!) : null };
};

/* ---------- links ---------- */

test('links: tournament, stage, other pages and the older www site give the ids; anything else is refused', () => {
  assert.deepEqual(parseToornamentLink('https://play.toornament.com/en_US/tournaments/2606138892358238208/'), { tournamentId: '2606138892358238208' });
  assert.deepEqual(parseToornamentLink(' https://play.toornament.com/en_US/tournaments/2606138892358238208/stages/2606170040841388032/ '), {
    tournamentId: '2606138892358238208',
    stageId: '2606170040841388032',
  });
  assert.deepEqual(parseToornamentLink('https://play.toornament.com/fr/tournaments/123/participants/'), { tournamentId: '123' });
  assert.deepEqual(parseToornamentLink('https://www.toornament.com/en_US/tournaments/1341889430865920000/information'), { tournamentId: '1341889430865920000' });
  assert.deepEqual(parseToornamentLink('https://play.toornament.com/en_US/tournaments/42/stages/77'), { tournamentId: '42', stageId: '77' });
  for (const bad of ['', 'not a link', 'https://evil.example/tournaments/123/', 'https://toornament.com.evil.example/tournaments/1/', 'https://play.toornament.com/en_US/', 'https://play.toornament.com/en_US/tournaments/abc/', 'ftp://play.toornament.com/tournaments/1/']) {
    assert.equal(typeof parseToornamentLink(bad), 'string', bad || '(empty)');
  }
  assert.equal(toornamentLinkProblem(''), '', 'empty is fine (no link)');
  assert.match(toornamentLinkProblem('https://challonge.com/abc'), /Only toornament\.com/);
  assert.equal(isToornamentHost('play.toornament.com'), true);
  assert.equal(isToornamentHost('TOORNAMENT.COM.'), true);
  assert.equal(isToornamentHost('nottoornament.com'), false);
  assert.equal(toornamentApi.nodes('1', '2', 128), 'https://play.toornament.com/api/bracket-nodes?tournament_ids=1&stage_ids=2&offset=128&limit=128');
});

test('applyToornamentLink: set, keep what was applied while the link is the same, clear', () => {
  const s = fixtureStore('s1', 'e1', null) as unknown as Store;
  applyToornamentLink(s, ' https://play.toornament.com/en_US/tournaments/1/ ');
  assert.deepEqual(s.toornament, { url: 'https://play.toornament.com/en_US/tournaments/1/' });
  s.toornament!.stageId = '9';
  applyToornamentLink(s, 'https://play.toornament.com/en_US/tournaments/1/');
  assert.equal(s.toornament!.stageId, '9');
  applyToornamentLink(s, 'https://play.toornament.com/en_US/tournaments/2/');
  assert.deepEqual(s.toornament, { url: 'https://play.toornament.com/en_US/tournaments/2/' });
  applyToornamentLink(s, '  ');
  assert.equal(s.toornament, undefined);
});

test('schema: store.toornament must be a toornament.com tournament link with digit stage ids', () => {
  const ok = { ...fixtureStore('s1', 'e1', null), toornament: { url: 'https://play.toornament.com/en_US/tournaments/1/', stageId: '22', stageName: 'Playoffs', appliedAt: '2026-10-23T10:00:00.000Z', by: 'super' } };
  assert.deepEqual(validateDocument('stores', ok), []);
  const probs = (t: unknown) => validateDocument('stores', { ...ok, toornament: t }).join(' | ');
  assert.match(probs({ url: 'https://evil.example/x' }), /toornament\.url/);
  assert.match(probs({ url: '' }), /toornament\.url/);
  assert.match(probs({ url: 'https://play.toornament.com/en_US/tournaments/1/', stageId: '../x' }), /toornament\.stageId/);
  assert.match(probs({ url: 'https://play.toornament.com/en_US/tournaments/1/', appliedAt: 'soon' }), /toornament\.appliedAt/);
  assert.match(probs('https://play.toornament.com/en_US/tournaments/1/'), /toornament: must be an object/);
});

/* ---------- stages ---------- */

test('stages: only single elimination is usable; the others are named and explained', () => {
  assert.deepEqual(stageSupport('single_elimination'), { supported: true });
  for (const [type, why] of [
    ['double_elimination', /Double elimination.*losers’ bracket/],
    ['pools', /Groups.*ranked in a table/],
    ['league', /League/],
    ['swiss', /Swiss.*standings/],
    ['bracket_groups', /Bracket groups/],
    ['ffa_single_elimination', /more than two players/],
    ['something_new', /something new/],
  ] as const) {
    const s = stageSupport(type);
    assert.equal(s.supported, false, type);
    assert.match(s.reason!, why, type);
    assert.match(s.reason!, /single-elimination/, type);
  }
  const multi = first('multi');
  assert.deepEqual(multi.stages.map((s) => [s.name, s.type, s.supported]), [['Regular Season', 'league', false], ['Playoffs', 'single_elimination', true]]);
  assert.equal(multi.stage!.name, 'Playoffs', 'the first usable stage is shown first');
  assert.equal(pickStage(multi.stages, multi.stages[0].id)!.name, 'Regular Season', 'unless the link named a stage');
  const de = first('de');
  assert.equal(de.stage!.supported, false);
  assert.match(de.stage!.reason!, /Double elimination/);
  const t = readTournament(fixture('se8').tournament);
  assert.equal(t.status, 'completed');
  assert.equal(t.page, 'https://play.toornament.com/en_US/tournaments/2606138892358238208/');
  assert.throws(() => readStages({ nope: 1 }), /unexpected format/);
});

/* ---------- the first round ---------- */

test('bracket: an 8-slot stage with 7 players → Toornament’s exact first round, the empty slot as a BYE', () => {
  const { bracket } = first('se8');
  assert.equal(bracket!.mode, 'pairs');
  assert.equal(bracket!.problem, undefined);
  assert.deepEqual(bracket!.pairs, [
    ['Diya Patel', null],
    ['Aarav Shah', 'Kabir Singh'],
    ['Ishaan Gupta', 'Asha Rao'],
    ['Vikram Nair', 'Rohan Mehta'],
  ]);
  // Seeds are the slots' seeds in a standard 8 bracket (1 8 4 5 2 7 3 6).
  assert.deepEqual(bracket!.players, ['Diya Patel', 'Ishaan Gupta', 'Vikram Nair', 'Aarav Shah', 'Kabir Singh', 'Rohan Mehta', 'Asha Rao']);
  assert.equal(bracket!.played, 6);
  assert.ok(bracket!.notes.some((n) => /6 results.*aren’t copied/.test(n)));
  assert.ok(bracket!.notes.some((n) => /1 registered on Toornament but not in this stage: Meera Iyer/.test(n)), bracket!.notes.join('\n'));
});

test('bracket: Toornament skips bye matches — a player placed straight into round 2 becomes “player vs BYE”', () => {
  const { bracket } = first('se7');
  assert.equal(bracket!.mode, 'pairs');
  assert.deepEqual(bracket!.pairs, [
    ['Rohan Mehta', null],
    ['Aarav Shah', 'Ishaan Gupta'],
    ['Vikram Nair', 'Kabir Singh'],
    ['Meera Iyer', 'Asha Rao'],
  ]);
  // Standard seeding of the derived seed order gives the very same bracket.
  const players: Player[] = bracket!.players.map((name, i) => ({ id: name, name, seed: i + 1 }));
  const standard = buildBracket(players, null, 'x').filter((m) => m.round === 0).map((m) => [m.a, m.b]);
  assert.deepEqual(standard, bracket!.pairs);
});

test('bracket: an empty first-round match (BYE vs BYE) can’t be held — explained, with the placed players as a seeded list', () => {
  const { bracket } = first('se12');
  assert.equal(bracket!.mode, 'seeded');
  assert.equal(bracket!.pairs, null);
  assert.match(bracket!.problem!, /First-round match 2 on Toornament has nobody in it.*16 slots for 10 players.*set the stage size to 10/);
  assert.equal(bracket!.players.length, 10);
  assert.ok(bracket!.notes.some((n) => /3rd-place match/.test(n)));
});

test('bracket: a stage nobody is placed in yet offers the registered participants, saying so', () => {
  const { bracket, participants } = first('multi');
  assert.equal(bracket!.mode, 'seeded');
  assert.match(bracket!.problem!, /Nobody is placed in this stage.*earlier stage.*8 registered participants/);
  assert.deepEqual(bracket!.players, participants.map((p) => p.name));
});

test('bracket: no nodes, two brackets, repeated names, odd shapes', () => {
  const reg = [{ id: '1', name: 'Asha Rao' }, { id: '2', name: 'Rohan Mehta' }];
  assert.match(bracketFromNodes([], reg).problem!, /hasn’t generated this stage’s bracket.*2 registered/);
  const node = (id: string, round: number, group: string, a: unknown, b: unknown) => ({ id, branch: 'wb', group: { id: group }, round: { number: round }, status: 'pending', opponents: [a, b] });
  const p = (id: string, name: string, position: number) => ({ position, participant: { id, name }, sourceType: 'none', sourceNode: null });
  const win = (from: string, position: number) => ({ position, participant: null, sourceType: 'winner', sourceNode: { id: from } });
  const two = [node('a', 1, 'g1', p('1', 'Asha', 1), p('2', 'Rohan', 2)), node('b', 1, 'g2', p('3', 'Kabir', 1), p('4', 'Meera', 2))];
  assert.match(bracketFromNodes(two, reg).problem!, /2 separate brackets/);
  // Same name twice (ignoring case and spacing) → numbered, and said so.
  const dup = [node('f', 2, 'g', win('s1', 1), win('s2', 2)), node('s1', 1, 'g', p('1', 'Asha  Rao', 1), p('2', 'asha rao', 2)), node('s2', 1, 'g', p('3', 'Kabir', 1), p('4', 'Meera', 2))];
  const d = bracketFromNodes(dup, []);
  assert.equal(d.mode, 'pairs');
  assert.deepEqual(d.pairs, [['Asha Rao', 'asha rao (2)'], ['Kabir', 'Meera']]);
  assert.ok(d.notes.some((n) => /more than once/.test(n)));
  // The order Toornament lists opponents in is the order it draws them (top first), whatever their
  // `position` numbers say: the final lists s2 (position 2) first, so s2 is the upper half.
  const swapped = [node('f', 2, 'g', win('s2', 2), win('s1', 1)), node('s1', 1, 'g', p('2', 'Rohan', 2), p('1', 'Asha', 1)), node('s2', 1, 'g', p('3', 'Kabir', 1), p('4', 'Meera', 2))];
  assert.deepEqual(bracketFromNodes(swapped, []).pairs, [['Kabir', 'Meera'], ['Rohan', 'Asha']]);
  // A loser feed in the winners' tree isn't single elimination.
  const odd = [node('f', 2, 'g', win('s1', 1), { position: 2, participant: null, sourceType: 'loser', sourceNode: { id: 's1' } }), node('s1', 1, 'g', p('1', 'A', 1), p('2', 'B', 2))];
  assert.match(bracketFromNodes(odd, []).problem!, /shape Field Desk can’t copy/);
  // Long and blank names are tidied.
  const names = readParticipants({ items: [{ id: '9', name: `  ${'x'.repeat(100)} ` }, { id: '8', name: '' }] });
  assert.equal(names[0].name.length, 80);
  assert.equal(names[1].name, 'Unnamed participant');
});

/* ---------- the order matches Toornament's page ---------- */

/*
 * Toornament draws a round top to bottom by match number, and a match's two sides in the order of
 * its `opponents` array (the live API lists position 2 first in some matches, and a final's
 * position 1 can be the lower half — position is not the drawing order). Below, the expected
 * picture is worked out from the raw nodes by *match number* (a different route from the code's),
 * and our built chart must be the same picture: first round top to bottom, and every later match
 * fed by our matches 2i (upper source) and 2i+1 (lower source).
 */
interface RawOpponent {
  position: number;
  participant: { id: string; name: string } | null;
  sourceType: string;
  sourceNode: { id: string } | null;
}
interface RawNode {
  id: string;
  number: number;
  branch: string;
  round: { number: number };
  opponents: RawOpponent[];
}
interface Placed {
  node: RawNode;
  start: number; // first slot of the node's 2^round slots
  sides: { name: string | null; source: RawNode | null }[]; // top first
}

function pictureOf(nodes: RawNode[]) {
  const wb = nodes.filter((n) => n.branch !== 'lb');
  const byId = new Map(wb.map((n) => [n.id, n]));
  const rounds = Math.max(...wb.map((n) => n.round.number));
  const final = wb.filter((n) => n.round.number === rounds);
  assert.equal(final.length, 1);
  const slots: (string | null)[] = [];
  const placed = new Map<string, Placed>();
  const walk = (n: RawNode) => {
    const start = slots.length;
    // Top side first: a player placed straight in comes first; winners by the match number they come from.
    const key = (o: RawOpponent) => (o.sourceType === 'winner' ? byId.get(o.sourceNode!.id)!.number : -1);
    const sides = [...n.opponents].sort((a, b) => key(a) - key(b)).map((o) => ({ name: o.participant?.name ?? null, source: o.sourceType === 'winner' ? byId.get(o.sourceNode!.id)! : null }));
    for (const side of sides) {
      if (side.source) walk(side.source);
      else slots.push(side.name, ...Array<null>(2 ** (n.round.number - 1) - 1).fill(null));
    }
    placed.set(n.id, { node: n, start, sides });
  };
  walk(final[0]);
  const pairs: [string | null, string | null][] = [];
  for (let i = 0; i < slots.length; i += 2) pairs.push([slots[i], slots[i + 1]]);
  return { placed, rounds, pairs, slots };
}

/** Our first round must be Toornament's picture, and every Toornament match must sit where our chart feeds it the same way. */
function assertSamePicture(name: string, nodes: RawNode[], pairs: [string | null, string | null][]) {
  const pic = pictureOf(nodes);
  assert.deepEqual(pairs, pic.pairs, `${name}: first round top to bottom`);
  const players: Player[] = pic.slots.filter((x): x is string => !!x).map((n, i) => ({ id: n, name: n, seed: i + 1 }));
  const chart = buildBracket(players, pairs, 'x');
  const at = (r: number, i: number) => chart.find((m) => m.round === r && m.index === i)!;
  const leaves = (r: number, i: number): string[] => (r === 0 ? [at(0, i).a, at(0, i).b].filter((x): x is string => !!x) : [...leaves(r - 1, 2 * i), ...leaves(r - 1, 2 * i + 1)]);
  const under = (n: RawNode): string[] => n.opponents.flatMap((o) => (o.sourceType === 'winner' ? under(pic.placed.get(o.sourceNode!.id)!.node) : o.participant ? [o.participant.name] : []));
  for (let r = 1; r <= pic.rounds; r++) {
    const row = [...pic.placed.values()].filter((p) => p.node.round.number === r).sort((a, b) => a.node.number - b.node.number);
    const starts = row.map((p) => p.start);
    // Match numbers run top to bottom in the chart as well.
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${name}: round ${r} numbered top to bottom`);
    for (const p of row) {
      const i = p.start / 2 ** r;
      assert.ok(Number.isInteger(i), `${name}: round ${r} #${p.node.number} sits on a slot boundary`);
      if (r === 1) {
        assert.deepEqual([at(0, i).a, at(0, i).b], p.sides.map((x) => x.name), `${name}: round 1 #${p.node.number}`);
        continue;
      }
      // Fed by our matches 2i and 2i+1 of the round before — the upper source in 2i.
      p.sides.forEach((side, k) => {
        const mine = leaves(r - 2, 2 * i + k).sort();
        const theirs = (side.source ? under(side.source) : side.name ? [side.name] : []).sort();
        assert.deepEqual(mine, theirs, `${name}: round ${r} #${p.node.number}, ${k === 0 ? 'upper' : 'lower'} feeder`);
      });
    }
  }
}

test('order: se8 — Toornament’s first round top to bottom, each match fed by the same two sources in the same order', () => {
  const { f, bracket } = first('se8');
  assert.equal(bracket!.mode, 'pairs');
  // Names top to bottom, as on Toornament's page (round 1 numbers 1–4; opponents in drawing order).
  assert.deepEqual(bracket!.pairs!.flat(), ['Diya Patel', null, 'Aarav Shah', 'Kabir Singh', 'Ishaan Gupta', 'Asha Rao', 'Vikram Nair', 'Rohan Mehta']);
  assertSamePicture('se8', f.nodes.items, bracket!.pairs!);
  // The final lists the lower half as position 1; the upper half (Diya's, round 1 #1–2) must still be on top.
  const final = f.nodes.items.find((n: RawNode) => n.round.number === 3) as RawNode;
  assert.equal(final.opponents.find((o) => o.position === 1)!.participant!.name, 'Asha Rao');
  assert.deepEqual(bracket!.pairs!.slice(0, 2).flat().filter(Boolean), ['Diya Patel', 'Aarav Shah', 'Kabir Singh']);
});

test('order: se7 (byes) — the player placed in round 2 sits in the right half, with their BYE beside them', () => {
  const { f, bracket } = first('se7');
  assert.equal(bracket!.mode, 'pairs');
  assert.deepEqual(bracket!.pairs!.flat(), ['Rohan Mehta', null, 'Aarav Shah', 'Ishaan Gupta', 'Vikram Nair', 'Kabir Singh', 'Meera Iyer', 'Asha Rao']);
  assertSamePicture('se7', f.nodes.items, bracket!.pairs!);
});

test('order: se12 — an empty round-1 match is still refused; filled in, the 12 players read like Toornament’s page', () => {
  const { f, bracket, participants, stage } = first('se12');
  assert.equal(bracket!.mode, 'seeded');
  assert.match(bracket!.problem!, /First-round match 2 on Toornament has nobody in it/);
  // Fill round-1 match 1 (the empty one) as Toornament would once the field is complete.
  const nodes = JSON.parse(JSON.stringify(f.nodes.items)) as RawNode[];
  const empty = nodes.find((n) => n.round.number === 1 && n.number === 1)!;
  empty.opponents[0].participant = { id: '9001', name: 'Zed One' };
  empty.opponents[1].participant = { id: '9002', name: 'Zed Two' };
  const full = bracketFromNodes(nodes, participants, stage!);
  assert.equal(full.mode, 'pairs', full.problem);
  assert.deepEqual(full.pairs!.flat(), [
    'Neel Joshi', null, 'Zed One', 'Zed Two', // upper quarter: round 2 #1 (Neel placed, fed by round 1 #1)
    'Aarav Shah', null, 'Asha Rao', 'Ishaan Gupta', // round 2 #2
    'Tara Bose', null, 'Kabir Singh', 'Meera Iyer', // round 2 #3
    'Sara Khan', null, 'Rohan Mehta', 'Vikram Nair', // round 2 #4
  ]);
  assertSamePicture('se12', nodes, full.pairs!);
});

/* ---------- Toornament's "Match #stage.group.round.match" on every Field Desk match ---------- */

/*
 * bracketFromNodes also says which Toornament match sits at each Field Desk position
 * (round 0 = first round, index in the round): `nodes` with its id and "stage.group.round.match"
 * label. Synthetic nodes in the live API's shape: stage {number}, group {id, number}, round {number}, number.
 */
const tp = (id: string, name: string, position: number) => ({ position, participant: { id, name }, sourceType: 'none', sourceNode: null });
const tw = (from: string, position: number) => ({ position, participant: null, sourceType: 'winner', sourceNode: { id: from } });
const tnone = (position: number) => ({ position, participant: null, sourceType: 'none', sourceNode: null }); // "To be determined"
const tnode = (id: string, round: number, number: number, a: unknown, b: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  branch: 'wb',
  stage: { id: 'st', number: 1, name: 'Playoffs' },
  group: { id: 'g', number: 1, name: 'Main Bracket' },
  round: { number: round },
  number,
  status: 'pending',
  opponents: [a, b],
  ...extra,
});
const refs = (b: { nodes: { round: number; index: number; id: string; label: string }[] }) => b.nodes.map((n) => `${n.round}:${n.index}=${n.id}@${n.label}`);

test('match numbers: a full 8-player bracket — every match is the Toornament match at its position', () => {
  const nodes = [
    tnode('r3', 3, 1, tw('r2b', 1), tw('r2a', 2)), // the final lists its lower half first, as the live API does
    tnode('r2a', 2, 1, tw('r1a', 1), tw('r1b', 2)),
    tnode('r2b', 2, 2, tw('r1c', 1), tw('r1d', 2)),
    tnode('r1a', 1, 1, tp('1', 'A', 1), tp('2', 'B', 2)),
    tnode('r1b', 1, 2, tp('3', 'C', 1), tp('4', 'D', 2)),
    tnode('r1c', 1, 3, tp('5', 'E', 1), tp('6', 'F', 2)),
    tnode('r1d', 1, 4, tp('7', 'G', 1), tp('8', 'H', 2)),
  ];
  const b = bracketFromNodes(nodes, [], { number: 1, status: 'running' });
  assert.equal(b.mode, 'pairs');
  // The lower half (r2b) is drawn first, so Toornament's "round 2, match 2" is our upper semifinal feeder.
  assert.deepEqual(b.pairs, [['E', 'F'], ['G', 'H'], ['A', 'B'], ['C', 'D']]);
  assert.deepEqual(refs(b), [
    '0:0=r1c@1.1.1.3', '0:1=r1d@1.1.1.4', '0:2=r1a@1.1.1.1', '0:3=r1b@1.1.1.2',
    '1:0=r2b@1.1.2.2', '1:1=r2a@1.1.2.1',
    '2:0=r3@1.1.3.1',
  ]);
  // The same positions buildBracket lays out: every one exists, once.
  const players: Player[] = b.players.map((n, i) => ({ id: n, name: n, seed: i + 1 }));
  const built = buildBracket(players, b.pairs, 'x');
  assert.equal(built.length, b.nodes.length);
  for (const n of b.nodes) assert.equal(built.filter((m) => m.round === n.round && m.index === n.index).length, 1);
});

test('match numbers: the real 8- and 7-player stages — each mapped node sits where its players are; a bye maps to nothing', () => {
  type Raw = RawNode & { group: { number: number }; stage: { number: number } };
  for (const name of ['se8', 'se7']) {
    const { f, bracket } = first(name);
    assert.equal(bracket!.mode, 'pairs');
    const raw = new Map<string, Raw>(f.nodes.items.map((n: Raw) => [n.id, n]));
    const wb = f.nodes.items.filter((n: RawNode) => n.branch !== 'lb');
    assert.equal(bracket!.nodes.length, wb.length, `${name}: one entry per Toornament match`);
    assert.equal(new Set(bracket!.nodes.map((n) => n.id)).size, wb.length);
    for (const n of bracket!.nodes) {
      const r = raw.get(n.id)!;
      assert.equal(n.round, r.round.number - 1, `${name}: Toornament round ${r.round.number} is our round ${n.round}`);
      assert.equal(n.label, `${r.stage.number}.${r.group.number}.${r.round.number}.${r.number}`);
      if (n.round === 0) assert.deepEqual(bracket!.pairs![n.index], r.opponents.map((o) => o.participant?.name ?? null), `${name}: ${n.label}`);
    }
    if (name === 'se7') {
      // The player placed in round 2 is "Rohan Mehta vs BYE" with no Toornament match of its own.
      assert.deepEqual(bracket!.pairs![0], ['Rohan Mehta', null]);
      assert.ok(!bracket!.nodes.some((n) => n.round === 0 && n.index === 0));
      assert.equal(bracket!.nodes.length, 6);
    }
  }
});

test('match numbers: 12 players in a 16-slot stage — the four top seeds sit in round 2, their byes map to nothing', () => {
  const r1 = [1, 2, 3, 4].map((k) => tnode(`a${k}`, 1, k, tp(`${k}1`, `Low ${k}A`, 1), tp(`${k}2`, `Low ${k}B`, 2)));
  const r2 = [1, 2, 3, 4].map((k) => tnode(`b${k}`, 2, k, tp(`${k}0`, `Top ${k}`, 1), tw(`a${k}`, 2)));
  const r3 = [1, 2].map((k) => tnode(`c${k}`, 3, k, tw(`b${2 * k - 1}`, 1), tw(`b${2 * k}`, 2)));
  const nodes = [tnode('d1', 4, 1, tw('c1', 1), tw('c2', 2)), ...r3, ...r2, ...r1];
  const b = bracketFromNodes(nodes, [], { number: 2, status: 'running' });
  assert.equal(b.mode, 'pairs', b.problem);
  assert.equal(b.pairs!.length, 8);
  // Each round-2 node is "Top k vs BYE" (no match of its own) followed by the round-1 match that feeds it.
  assert.deepEqual(b.pairs!.slice(0, 2), [['Top 1', null], ['Low 1A', 'Low 1B']]);
  const expected = [
    ...[1, 2, 3, 4].map((k) => `0:${2 * k - 1}=a${k}@2.1.1.${k}`), // odd first-round positions only
    ...[1, 2, 3, 4].map((k) => `1:${k - 1}=b${k}@2.1.2.${k}`),
    '2:0=c1@2.1.3.1', '2:1=c2@2.1.3.2',
    '3:0=d1@2.1.4.1',
  ];
  assert.deepEqual(refs(b), expected);
  assert.equal(b.nodes.length, 11); // of 15 Field Desk matches; the four byes have none
  assert.ok([0, 2, 4, 6].every((i) => !b.nodes.some((n) => n.round === 0 && n.index === i)));
});

test('match numbers: a first-round match with one side "To be determined" (auto-completed) is mapped like any other', () => {
  const nodes = [
    tnode('f', 3, 1, tw('s2', 1), tw('s1', 2)),
    tnode('s1', 2, 1, tw('q1', 1), tw('q2', 2)),
    tnode('s2', 2, 2, tw('q3', 1), tw('q4', 2)),
    tnode('q1', 1, 1, tp('1', 'Asha', 1), tnone(2), { status: 'completed' }),
    tnode('q2', 1, 2, tp('2', 'Rohan', 1), tp('3', 'Kabir', 2)),
    tnode('q3', 1, 3, tp('4', 'Meera', 1), tp('5', 'Diya', 2)),
    tnode('q4', 1, 4, tp('6', 'Ishaan', 1), tp('7', 'Vikram', 2)),
  ];
  const b = bracketFromNodes(nodes, [], { number: 1, status: 'running' });
  assert.equal(b.mode, 'pairs');
  assert.deepEqual(b.pairs![2], ['Asha', null]); // s1 (position 2 of the final) is the lower half
  assert.deepEqual(b.nodes.find((n) => n.round === 0 && n.index === 2), { round: 0, index: 2, id: 'q1', label: '1.1.1.1' });
  assert.equal(b.nodes.length, 7);
});

test('match numbers: group number — taken from the node, else 1 for the stage’s one group; the stage from the stage, else from the nodes, else no labels', () => {
  const one = (over: Record<string, unknown>) => [tnode('x', 1, 3, tp('1', 'A', 1), tp('2', 'B', 2), over)];
  const stage = { number: 4, status: 'pending' };
  // The group is just an id (no number): the stage has one group, so group 1.
  assert.deepEqual(refs(bracketFromNodes(one({ group: { id: 'g' } }), [], stage)), ['0:0=x@4.1.1.3']);
  assert.deepEqual(refs(bracketFromNodes(one({ group: '2200' }), [], stage)), ['0:0=x@4.1.1.3']);
  assert.deepEqual(refs(bracketFromNodes(one({ group: undefined }), [], stage)), ['0:0=x@4.1.1.3']);
  // A numbered group keeps its number.
  assert.deepEqual(refs(bracketFromNodes(one({ group: { id: 'g', number: 2 } }), [], stage)), ['0:0=x@4.2.1.3']);
  // No stage given: the one on the nodes. Neither: no labels (the pairs are still fine).
  assert.deepEqual(refs(bracketFromNodes(one({ stage: { id: 's', number: 3 } }), [])), ['0:0=x@3.1.1.3']);
  const none = bracketFromNodes(one({ stage: undefined }), []);
  assert.equal(none.mode, 'pairs');
  assert.deepEqual(none.nodes, []);
  // A node without a match number can't be labelled and is left out.
  assert.deepEqual(bracketFromNodes(one({ number: undefined }), [], stage).nodes, []);
  // A seeded fallback has no nodes.
  assert.deepEqual(bracketFromNodes([], [{ id: '1', name: 'A' }, { id: '2', name: 'B' }]).nodes, []);
});

test('match numbers: planImport carries the nodes with the pairs, and only with pairs', () => {
  const b = bracketFromNodes([tnode('only', 1, 1, tp('1', 'Asha', 1), tp('2', 'Rohan', 2))], [], { number: 1, status: 'running' });
  assert.deepEqual(planImport(b, []).nodes, [{ round: 0, index: 0, id: 'only', label: '1.1.1.1' }]);
  assert.deepEqual(planImport({ players: ['A', 'B'], pairs: null, nodes: b.nodes }, []).nodes, []);
  assert.deepEqual(planImport({ players: ['A', 'B'], pairs: null }, []).nodes, []);
});

/* ---------- onto the store ---------- */

let seq = 0;
const event: TournamentEvent = { id: 'e1', name: 'Synthetic Campaign', date: '2026-10-24', games: [], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z' };
const ctx = (role: 'super' | 'admin' = 'super'): CommandContext => ({ commandId: `tn-${++seq}`, now: '2026-10-23T10:00:00.000Z', actor: { principal: role === 'super' ? 'super' : 'admin:a1', name: 'X', role }, event });
const csvPlayer = (name: string, phone: string | undefined, seed: number): Player => (phone ? { id: playerIdFor(phone, name), name, seed, phone } : { id: playerIdFor(undefined, name), name, seed });

function storeWithCsv() {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  const players = [csvPlayer('asha  RAO', '9820011111', 1), csvPlayer('Rohan Mehta', '9820022222', 2), csvPlayer('Kabir Singh', undefined, 3), csvPlayer('Zoya Ali', '9820033333', 4)];
  let st = applyCommand(s, { type: 'players.set', base: 0, players }, ctx());
  st = { ...st, day: { ...st.day, checkIn: { [players[0].id]: '2026-10-24T09:00:00.000Z', [players[3].id]: '2026-10-24T09:01:00.000Z' }, checkInSource: { [players[0].id]: 'self' } } };
  return { store: st, players };
}

test('plan: names matched ignoring case and spacing keep id + phone; new ones come without; the rest are dropped', () => {
  const { store, players } = storeWithCsv();
  const { bracket } = first('se8');
  const plan = planImport(bracket!, store.day.players);
  assert.deepEqual(plan.matched.map((p) => [p.name, p.phone]), [['Kabir Singh', undefined], ['Rohan Mehta', '9820022222'], ['asha RAO', '9820011111']]);
  assert.equal(plan.matched[2].id, players[0].id);
  assert.deepEqual(plan.added.map((p) => p.name), ['Diya Patel', 'Ishaan Gupta', 'Vikram Nair', 'Aarav Shah']);
  assert.ok(plan.added.every((p) => !p.phone && p.id === playerIdFor(undefined, p.name)));
  assert.deepEqual(plan.dropped.map((p) => p.name), ['Zoya Ali']);
  assert.deepEqual(plan.players.map((p) => p.seed), [1, 2, 3, 4, 5, 6, 7]);
  const byId = new Map(plan.players.map((p) => [p.id, p.name]));
  assert.deepEqual(plan.pairs!.map(([a, b]) => [a && byId.get(a), b && byId.get(b)]), [
    ['Diya Patel', null],
    ['Aarav Shah', 'Kabir Singh'],
    ['Ishaan Gupta', 'asha RAO'],
    ['Vikram Nair', 'Rohan Mehta'],
  ]);
});

test('plan: a Toornament name that is a player’s in-game name matches them too; names win over in-game names', () => {
  const s = fixtureStore('s1', 'e1', 'a1') as unknown as Store;
  const asha: Player = { ...csvPlayer('Asha Rao', '9820011111', 1), ign: 'Ash R' };
  const rohan: Player = { ...csvPlayer('Rohan Mehta', '9820022222', 2), ign: 'RM' };
  const kabir: Player = { ...csvPlayer('Kabir Singh', undefined, 3), ign: 'Rohan Mehta' }; // an IGN that is someone else's name
  const zoya: Player = { ...csvPlayer('Zoya Ali', '9820033333', 4), ign: 'z0ya' };
  const store = applyCommand(s, { type: 'players.set', base: 0, players: [asha, rohan, kabir, zoya] }, ctx());
  assert.deepEqual(store.day.players.map((p) => p.ign), ['Ash R', 'RM', 'Rohan Mehta', 'z0ya'], 'players.set keeps the in-game names');

  const plan = planImport({ players: ['ash  r', 'Rohan Mehta', 'Z0YA', 'New Guy'], pairs: [['ash  r', 'New Guy'], ['Rohan Mehta', 'Z0YA']] }, store.day.players);
  assert.deepEqual(plan.matched.map((p) => [p.id, p.name, p.phone, p.ign]), [
    [asha.id, 'Asha Rao', '9820011111', 'Ash R'],
    [rohan.id, 'Rohan Mehta', '9820022222', 'RM'],
    [zoya.id, 'Zoya Ali', '9820033333', 'z0ya'],
  ]);
  assert.deepEqual(plan.added.map((p) => p.name), ['New Guy']);
  assert.deepEqual(plan.dropped.map((p) => p.name), ['Kabir Singh'], 'Rohan’s own name beats Kabir’s IGN');
  const byId = new Map(plan.players.map((p) => [p.id, p.name]));
  assert.deepEqual(plan.pairs!.map(([a, b]) => [a && byId.get(a), b && byId.get(b)]), [
    ['Asha Rao', 'New Guy'],
    ['Rohan Mehta', 'Zoya Ali'],
  ]);
  const after = applyCommand(store, { type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs }, ctx());
  assert.equal(after.day.players.find((p) => p.id === asha.id)!.ign, 'Ash R', 'bracket.load keeps the in-game name');
});

test('applied as one bracket.load: Toornament’s pairings, phones and check-ins kept, dropped player’s check-in gone', () => {
  const { store, players } = storeWithCsv();
  const plan = planImport(first('se8').bracket!, store.day.players);
  const after = applyCommand(store, { type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs }, ctx());
  const name = new Map(after.day.players.map((p) => [p.id, p.name]));
  const r0 = after.day.matches.filter((m) => m.round === 0).sort((a, b) => a.index - b.index);
  assert.deepEqual(r0.map((m) => [m.a && name.get(m.a), m.b && name.get(m.b)]), [
    ['Diya Patel', null],
    ['Aarav Shah', 'Kabir Singh'],
    ['Ishaan Gupta', 'asha RAO'],
    ['Vikram Nair', 'Rohan Mehta'],
  ]);
  assert.equal(r0[0].bye, true, 'the BYE auto-advances');
  assert.equal(after.day.matches.length, 7);
  assert.equal(after.day.players.find((p) => p.id === players[0].id)!.phone, '9820011111');
  assert.deepEqual(Object.keys(after.day.checkIn), [players[0].id], 'Asha’s check-in stays; Zoya was dropped');
  assert.deepEqual(after.day.checkInSource, { [players[0].id]: 'self' });
  assert.equal(dayVersion(after), dayVersion(store) + 1);
});

test('applied: the seeded fallback builds a standard bracket; admins can’t; a stale or under-way store is refused', () => {
  const { store } = storeWithCsv();
  const seeded = planImport(first('se12').bracket!, store.day.players);
  assert.equal(seeded.pairs, null);
  const built = applyCommand(store, { type: 'bracket.load', base: dayVersion(store), players: seeded.players, pairs: null }, ctx());
  assert.equal(built.day.players.length, 10);
  assert.equal(built.day.matches.filter((m) => m.round === 0).length, 8);

  const plan = planImport(first('se8').bracket!, store.day.players);
  const cmd = { type: 'bracket.load' as const, base: dayVersion(store), players: plan.players, pairs: plan.pairs };
  assert.throws(() => applyCommand(store, cmd, ctx('admin')), /admin can’t bracket.load/);
  assert.throws(() => applyCommand(store, { ...cmd, base: dayVersion(store) - 1 }, ctx()), /changed on another device/);

  // Once a real match is live, nothing replaces the bracket.
  let live = applyCommand(store, cmd, ctx());
  const m = live.day.matches.find((x) => x.round === 0 && x.a && x.b)!;
  live = { ...live, day: { ...live.day, checkIn: { ...live.day.checkIn, [m.a!]: '2026-10-24T09:00:00.000Z', [m.b!]: '2026-10-24T09:00:00.000Z' } } };
  live = applyCommand(live, { type: 'match.start', base: dayVersion(live), matchId: m.id, station: 1 }, ctx());
  assert.throws(() => applyCommand(live, { ...cmd, base: dayVersion(live) }, ctx()), /under way/);
});

/* ---------- walk-ins registered at the desk (day.onSpot) ---------- */

/** What players.onspot leaves behind: the player on the list, checked in, and the registration. */
function withWalkIn(store: Store, name: string, phone?: string, ign?: string, toornament?: string): Store {
  const p: Player = { ...csvPlayer(name, phone, store.day.players.length + 1), ...(ign ? { ign } : {}) };
  const e: OnSpotEntry = { id: `os-${store.day.players.length}`, playerId: p.id, name, at: '2026-10-24T09:30:00.000Z', by: 'Synthetic admin', ...(phone ? { phone } : {}), ...(ign ? { ign } : {}), ...(toornament ? { toornament } : {}) };
  return { ...store, day: { ...store.day, players: [...store.day.players, p], checkIn: { ...store.day.checkIn, [p.id]: '2026-10-24T09:30:00.000Z' }, onSpot: [...(store.day.onSpot ?? []), e] } };
}

test('walk-ins: matched by name or IGN like everyone else — phone, IGN and check-in kept, found for marking', () => {
  let store = storeWithCsv().store;
  store = withWalkIn(store, 'Ravi Kumar', '9820044444', 'RaviK');
  store = withWalkIn(store, 'Meera Nair', '9820055555');
  const [ravi, meera] = store.day.onSpot!;
  // On Toornament HQ typed Ravi's gamertag and Meera's name.
  const plan = planImport({ players: ['Asha Rao', 'raviK', 'MEERA NAIR', 'Rohan Mehta'], pairs: [['Asha Rao', 'raviK'], ['MEERA NAIR', 'Rohan Mehta']] }, store.day.players, { onSpot: store.day.onSpot });
  assert.deepEqual(plan.onSpotFound.map((f) => [f.entry.id, f.player.id, f.player.phone, f.player.ign]), [
    [ravi.id, ravi.playerId, '9820044444', 'RaviK'],
    [meera.id, meera.playerId, '9820055555', undefined],
  ]);
  assert.deepEqual(plan.onSpotMissing, []);
  const after = applyCommand(store, { type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs }, ctx());
  assert.ok(after.day.checkIn[ravi.playerId] && after.day.checkIn[meera.playerId], 'walk-ins stay checked in');
  assert.equal(after.day.onSpot!.length, 2);
});

test('walk-ins Toornament doesn’t have yet: reported (not silently dropped); kept outside the pairings only when asked', () => {
  let store = storeWithCsv().store;
  store = withWalkIn(store, 'Ravi Kumar', '9820044444');
  store = withWalkIn(store, 'Meera Nair', undefined, undefined, '2026-10-24T09:40:00.000Z'); // marked, but not in this stage
  const bracket = first('se8').bracket!;
  const plan = planImport(bracket, store.day.players, { onSpot: store.day.onSpot });
  assert.deepEqual(plan.onSpotMissing.map((m) => [m.entry.name, m.player?.name, m.kept]), [
    ['Ravi Kumar', 'Ravi Kumar', false],
    ['Meera Nair', 'Meera Nair', false],
  ]);
  assert.deepEqual(plan.dropped.map((p) => p.name), ['Zoya Ali'], 'walk-ins are named separately, not as plain removals');
  assert.ok(!plan.players.some((p) => p.name === 'Ravi Kumar'));
  // The plan without them is what bracket.load takes today.
  applyCommand(store, { type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs }, ctx());

  const kept = planImport(bracket, store.day.players, { onSpot: store.day.onSpot, keepOutside: true });
  assert.deepEqual(kept.pairs, plan.pairs, 'the pairings are Toornament’s, unchanged');
  assert.deepEqual(kept.players.slice(-2).map((p) => [p.name, p.seed, p.phone]), [['Ravi Kumar', 8, '9820044444'], ['Meera Nair', 9, undefined]]);
  assert.ok(kept.onSpotMissing.every((m) => m.kept));
  // A seeded list would draw them into the bracket, so keepOutside does nothing there.
  const seeded = planImport(first('se12').bracket!, store.day.players, { onSpot: store.day.onSpot, keepOutside: true });
  assert.ok(seeded.onSpotMissing.every((m) => !m.kept) && !seeded.players.some((p) => p.name === 'Ravi Kumar'));
});

test('walk-ins whose player left the list earlier come back from their registration when Toornament has them', () => {
  let store = storeWithCsv().store;
  store = withWalkIn(store, 'Ravi Kumar', '9820044444', 'RaviK');
  store = withWalkIn(store, 'Dev Patel', undefined, undefined, '2026-10-24T09:40:00.000Z');
  const ravi = store.day.onSpot![0];
  // An earlier import without them took them off the list; the registrations stay.
  store = { ...store, day: { ...store.day, players: store.day.players.filter((p) => p.name !== 'Ravi Kumar' && p.name !== 'Dev Patel') } };
  const plan = planImport({ players: ['Asha Rao', 'RaviK'], pairs: [['Asha Rao', 'RaviK']] }, store.day.players, { onSpot: store.day.onSpot });
  assert.deepEqual(plan.onSpotFound.map((f) => [f.player.id, f.player.name, f.player.phone, f.player.ign]), [[ravi.playerId, 'Ravi Kumar', '9820044444', 'RaviK']]);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.onSpotMissing, [], 'Dev — marked and off the list — is nothing to warn about');
  // Still to add and off the list: warned about, nothing to keep.
  const notYet = planImport({ players: ['Asha Rao', 'Rohan Mehta'], pairs: [['Asha Rao', 'Rohan Mehta']] }, store.day.players, { onSpot: store.day.onSpot, keepOutside: true });
  assert.deepEqual(notYet.onSpotMissing.map((m) => [m.entry.name, m.player, m.kept]), [['Ravi Kumar', undefined, false]]);
  assert.equal(notYet.players.length, 2);
});

/* ---------- “Rohit Rajan (2)” is Toornament’s “Rohit Rajan” ---------- */

const twins = (...more: Player[]) => {
  const { store } = storeWithCsv();
  return { ...store, day: { ...store.day, players: [...store.day.players, ...more] } };
};

test('base name: the original was deleted, the “(2)” with the number is Toornament’s “Rohit Rajan” — phone, check-in and walk-in record kept, named as on Toornament', () => {
  const store = withWalkIn(storeWithCsv().store, 'Rohit Rajan (2)', '9820077777');
  const two = store.day.players.find((p) => p.name === 'Rohit Rajan (2)')!;
  const plan = planImport({ players: ['asha RAO', 'Rohit Rajan'], pairs: [['asha RAO', 'Rohit Rajan']] }, store.day.players, { onSpot: store.day.onSpot });
  assert.deepEqual(plan.added, []);
  const rohit = plan.players[1];
  assert.deepEqual([rohit.id, rohit.name, rohit.phone, rohit.seed], [two.id, 'Rohit Rajan', '9820077777', 2]);
  assert.deepEqual(plan.matched.map((p) => p.id), [plan.players[0].id, two.id]);
  assert.deepEqual(plan.pairs, [[plan.players[0].id, two.id]]);
  assert.deepEqual(plan.onSpotFound.map((f) => [f.entry.playerId, f.player.name]), [[two.id, 'Rohit Rajan']]);
  const after = applyCommand(store, { type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs }, ctx());
  assert.ok(after.day.checkIn[two.id], 'still checked in');
  assert.equal(after.day.players.find((p) => p.id === two.id)!.phone, '9820077777');
});

test('base name: both are still on the list — the one with the number is used, the number-less duplicate is dropped', () => {
  const original = csvPlayer('Rohit Rajan', undefined, 5);
  const two: Player = { ...csvPlayer('Rohit Rajan (2)', '9820077777', 6), ign: 'RoRa' };
  const plan = planImport({ players: ['asha RAO', 'Rohit Rajan'], pairs: [['asha RAO', 'Rohit Rajan']] }, twins(original, two).day.players);
  assert.deepEqual(plan.players.map((p) => [p.id, p.name, p.phone, p.ign]), [
    [playerIdFor('9820011111', 'asha  RAO'), 'asha RAO', '9820011111', undefined],
    [two.id, 'Rohit Rajan', '9820077777', 'RoRa'],
  ]);
  assert.ok(plan.dropped.some((p) => p.id === original.id), 'the duplicate without a number is a plain duplicate');
  assert.ok(!plan.dropped.some((p) => p.id === two.id) && !plan.added.length);
  // the other way round nothing changes: Toornament’s name goes to the player with that exact name
  const keep = planImport({ players: ['asha RAO', 'Rohit Rajan'], pairs: null }, twins(csvPlayer('Rohit Rajan', '9820066666', 5), csvPlayer('Rohit Rajan (2)', undefined, 6)).day.players);
  assert.equal(keep.players[1].phone, '9820066666');
  assert.ok(keep.dropped.some((p) => p.name === 'Rohit Rajan (2)'));
});

test('base name: two different people on Toornament as “Rohit Rajan” and “Rohit Rajan (2)” each match exactly, unchanged', () => {
  const original = csvPlayer('Rohit Rajan', undefined, 5);
  const two = csvPlayer('Rohit Rajan (2)', '9820077777', 6);
  const plan = planImport({ players: ['Rohit Rajan', 'Rohit Rajan (2)'], pairs: [['Rohit Rajan', 'Rohit Rajan (2)']] }, twins(original, two).day.players);
  assert.deepEqual(plan.players.map((p) => [p.id, p.name, p.phone]), [[original.id, 'Rohit Rajan', undefined], [two.id, 'Rohit Rajan (2)', '9820077777']]);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.dropped.map((p) => p.name), ['asha RAO', 'Rohan Mehta', 'Kabir Singh', 'Zoya Ali']);
});

test('base name: no guess between candidates — several without numbers, or several with — the name is added as before', () => {
  const run = (...more: Player[]) => planImport({ players: ['Rohit Rajan', 'asha RAO'], pairs: null }, twins(...more).day.players);
  const none = run(csvPlayer('Rohit Rajan (2)', undefined, 5), csvPlayer('Rohit Rajan (3)', undefined, 6));
  assert.deepEqual(none.added.map((p) => p.name), ['Rohit Rajan']);
  assert.ok(none.dropped.some((p) => p.name === 'Rohit Rajan (2)') && none.dropped.some((p) => p.name === 'Rohit Rajan (3)'));
  const phones = run(csvPlayer('Rohit Rajan (2)', '9820077777', 5), csvPlayer('Rohit Rajan (3)', '9820088888', 6));
  assert.deepEqual(phones.added.map((p) => p.name), ['Rohit Rajan']);
  // an exact match without a number stays when two “(n)” have numbers
  const stays = run(csvPlayer('Rohit Rajan', undefined, 5), csvPlayer('Rohit Rajan (2)', '9820077777', 6), csvPlayer('Rohit Rajan (3)', '9820088888', 7));
  assert.deepEqual(stays.added, []);
  assert.equal(stays.players[0].id, playerIdFor(undefined, 'Rohit Rajan'));
  // one with a number beats one without; a single one without is used
  const pick = run(csvPlayer('Rohit Rajan (2)', undefined, 5), csvPlayer('Rohit Rajan (3)', '9820088888', 6));
  assert.deepEqual([pick.players[0].phone, pick.players[0].name], ['9820088888', 'Rohit Rajan']);
  const lone = run(csvPlayer('Rohit Rajan (2)', undefined, 5));
  assert.deepEqual([lone.players[0].id, lone.players[0].name, lone.added.length], [playerIdFor(undefined, 'Rohit Rajan (2)'), 'Rohit Rajan', 0]);
  // only a trailing “(n)” is a tag
  const other = run(csvPlayer('Rohit Rajan Jr', '9820077777', 5), csvPlayer('Rohit Rajan (x)', '9820088888', 6));
  assert.deepEqual(other.added.map((p) => p.name), ['Rohit Rajan']);
});

test('base name: an in-game name match is not overruled, and a walk-in whose player left the list comes back under Toornament’s name', () => {
  const ign = planImport({ players: ['RoRa', 'asha RAO'], pairs: null }, twins({ ...csvPlayer('Someone Else', '9820055555', 5), ign: 'RoRa' }, csvPlayer('Rohit Rajan (2)', '9820077777', 6)).day.players);
  assert.deepEqual([ign.players[0].name, ign.players[0].phone], ['Someone Else', '9820055555']);
  let store = withWalkIn(storeWithCsv().store, 'Rohit Rajan (2)', '9820077777', 'RoRa');
  const entry = store.day.onSpot![0];
  store = { ...store, day: { ...store.day, players: store.day.players.filter((p) => p.id !== entry.playerId) } };
  const plan = planImport({ players: ['asha RAO', 'Rohit Rajan'], pairs: [['asha RAO', 'Rohit Rajan']] }, store.day.players, { onSpot: store.day.onSpot });
  assert.deepEqual([plan.players[1].id, plan.players[1].name, plan.players[1].phone, plan.players[1].ign], [entry.playerId, 'Rohit Rajan', '9820077777', 'RoRa']);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.onSpotFound.map((f) => f.entry.id), [entry.id]);
});

test('the bracket link goes to the stages, whatever page of the tournament the sheet gave', async () => {
  const { toornamentBracketPage } = await import('../src/lib/toornament.ts');
  const t = 'https://play.toornament.com/en_US/tournaments/2596019755383668735/';
  assert.equal(toornamentBracketPage(t), 'https://play.toornament.com/en_US/tournaments/2596019755383668735/stages/');
  assert.equal(toornamentBracketPage('https://play.toornament.com/tournaments/2596019755383668735/registration/'), 'https://play.toornament.com/en_US/tournaments/2596019755383668735/stages/');
  assert.equal(toornamentBracketPage(t, '2596019755383668999'), 'https://play.toornament.com/en_US/tournaments/2596019755383668735/stages/2596019755383668999/');
  assert.equal(toornamentBracketPage(`${t}stages/2596019755383668111/`, '2596019755383668999'), 'https://play.toornament.com/en_US/tournaments/2596019755383668735/stages/2596019755383668111/');
});

test('labelsToAdd counts the Toornament matches a bracket does not carry yet; sameFirstRound compares the first round by player', () => {
  const matches = buildBracket([1, 2, 3, 4].map((n) => ({ id: 'p' + n, name: 'P' + n, seed: n })), null, 'x');
  const nodes = [{ round: 0, index: 0, id: 'a', label: '1.1.1.1' }, { round: 0, index: 1, id: 'b', label: '1.1.1.2' }, { round: 1, index: 0, id: 'c', label: '1.1.2.1' }];
  assert.equal(labelsToAdd(matches, nodes), 3);
  const some = matches.map((m) => (m.round === 0 && m.index === 0 ? { ...m, toornament: { id: 'a', label: '1.1.1.1' } } : m.round === 1 ? { ...m, toornament: { id: 'c', label: '1.1.9.9' } } : m));
  assert.equal(labelsToAdd(some, nodes), 2, 'one already there; a different number counts');
  assert.equal(labelsToAdd(some, []), 0);
  assert.equal(labelsToAdd([], nodes), 3, 'a node with no match here still counts (the command refuses it)');
  const first = matches.filter((m) => m.round === 0).map((m) => [m.a, m.b] as [string | null, string | null]);
  assert.equal(sameFirstRound(matches, first), true);
  assert.equal(sameFirstRound(matches, [first[1], first[0]]), false);
  assert.equal(sameFirstRound(matches, first.slice(0, 1)), false);
});
