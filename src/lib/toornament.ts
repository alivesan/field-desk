/*
 * Toornament (toornament.com) brackets for HQ — the pure half. server/toornament-fetch.ts does
 * the fetching; this file turns what Toornament answers into names and first-round pairings,
 * and src/components/ToornamentImport.tsx turns those into a bracket.load command.
 *
 * What's public: the tournament pages (play.toornament.com/en_US/tournaments/<id>/…) are a
 * JavaScript shell — the HTML has no participant names or matches. The page itself reads a
 * same-origin JSON API with no key or sign-in, and so do we:
 *
 *   /api/tournaments/<tid>                                   name, status, participantType
 *   /api/stages?tournament_ids=<tid>&offset=0&limit=50       stages: type, status, settings.size
 *   /api/participants?tournament_ids=<tid>&offset&limit≤50   registered names (list order, no seeds)
 *   /api/bracket-nodes?tournament_ids&stage_ids&offset&limit≤128
 *        one node per match: round.number, opponents[{position, participant|null,
 *        sourceType 'none' | 'winner' | 'loser', sourceNode {id}}], branch 'wb' | 'lb'
 *   Lists answer { items, range: { offset, length, total } }; an unknown id 404s.
 *
 * Only single elimination fits Field Desk's bracket. Double elimination, groups, leagues, Swiss,
 * free-for-all and the rest are named and refused (stageSupport). Toornament doesn't create bye
 * matches: in a 12-slot stage the four top slots sit directly in round 2. bracketFromNodes walks
 * the tree from the final down, so a player placed in round 2 becomes "<player> vs BYE" in round
 * 1 — the same bracket. Order matters: Toornament draws a match's two sides in the order of its
 * `opponents` array (not by `position`, which can list the lower half first), and the tree is
 * walked in that order so our chart reads top to bottom like theirs. A first-round match with nobody on either side (an empty slot left in a
 * stage bigger than its field) can't be expressed here (BYE vs BYE); that is reported, with the
 * placed players offered as a seeded list instead. The 3rd-place match ('lb') is left out.
 *
 * Node-loadable: no browser APIs, explicit .ts imports only.
 */
import type { OnSpotEntry, Player, Store } from './types.ts';
import { isPow2, seedOrder } from './bracket.ts';
import { playerIdFor } from './phone.ts';
import { onSpotPlayer } from './onspot.ts';

export const TOORNAMENT_API = 'https://play.toornament.com/api/';
/** Largest page each list endpoint accepts (more → 400 "limit is outside the permitted range"). */
export const PAGE = { stages: 50, participants: 50, nodes: 128 } as const;
/** Field Desk's bracket limit (cleanPlayers in tournament.ts). */
export const MAX_PLAYERS = 256;
const MAX_NAME = 80;
const TOORNAMENT_ID = /^\d{1,24}$/;

export interface ToornamentLink {
  tournamentId: string;
  stageId?: string;
}

/** toornament.com and its subdomains (play., www., organizer., site.). Nothing else. */
export const isToornamentHost = (host: string) => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'toornament.com' || h.endsWith('.toornament.com');
};

/**
 * The ids in a link HQ copied from Toornament:
 *   https://play.toornament.com/en_US/tournaments/2606138892358238208/
 *   https://play.toornament.com/en_US/tournaments/2606138892358238208/stages/2606170040841388032/
 *   https://www.toornament.com/en_US/tournaments/2606138892358238208/information   (older site)
 * Any page under the tournament works (participants, matches…). Returns a problem string instead
 * when it isn't one.
 */
export function parseToornamentLink(raw: string): ToornamentLink | string {
  let u: URL;
  try {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) throw new Error();
    u = new URL(raw.trim());
  } catch {
    return 'That isn’t a link — copy it from the address bar on the tournament’s Toornament page.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'That isn’t a web link.';
  if (!isToornamentHost(u.hostname)) return 'Only toornament.com links — e.g. https://play.toornament.com/en_US/tournaments/<number>/';
  const t = u.pathname.match(/\/tournaments\/(\d+)(?:\/|$)/);
  if (!t || !TOORNAMENT_ID.test(t[1])) return 'No tournament in that link — open the tournament on Toornament and copy the address (it has /tournaments/<number>/ in it).';
  const s = u.pathname.match(/\/stages\/(\d+)(?:\/|$)/);
  return s && TOORNAMENT_ID.test(s[1]) ? { tournamentId: t[1], stageId: s[1] } : { tournamentId: t[1] };
}

/** For forms: '' when the link is fine (or empty), else what's wrong. */
export function toornamentLinkProblem(raw: string): string {
  if (!raw.trim()) return '';
  const r = parseToornamentLink(raw);
  return typeof r === 'string' ? r : '';
}

/** The public page for a tournament / stage — what HQ opens to check. */
export const toornamentPage = (l: ToornamentLink) =>
  `https://play.toornament.com/en_US/tournaments/${l.tournamentId}/${l.stageId ? `stages/${l.stageId}/` : ''}`;

/** The JSON URLs server/toornament-fetch.ts asks for. */
export const toornamentApi = {
  tournament: (tid: string) => `${TOORNAMENT_API}tournaments/${tid}`,
  stages: (tid: string) => `${TOORNAMENT_API}stages?tournament_ids=${tid}&offset=0&limit=${PAGE.stages}`,
  participants: (tid: string, offset: number) => `${TOORNAMENT_API}participants?tournament_ids=${tid}&offset=${offset}&limit=${PAGE.participants}`,
  nodes: (tid: string, sid: string, offset: number) => `${TOORNAMENT_API}bracket-nodes?tournament_ids=${tid}&stage_ids=${sid}&offset=${offset}&limit=${PAGE.nodes}`,
};

/**
 * Store details: set, change or clear a store's Toornament link (on a draft, inside update()).
 * Keeps what was last fetched / applied while the link is the same.
 */
export function applyToornamentLink(store: Store, raw: string) {
  const url = raw.trim();
  if (!url) delete store.toornament;
  else if (store.toornament?.url !== url) store.toornament = { url };
}

/* ---------- reading Toornament's JSON ---------- */

type Rec = Record<string, unknown>;
const isObj = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');
const idOf = (x: unknown) => (isObj(x) ? str(x.id) : str(x));

/** A list page → its items and the total Toornament says exists. Throws on anything else. */
export function readPage(json: unknown): { items: unknown[]; offset: number; total: number } {
  if (!isObj(json) || !Array.isArray(json.items)) throw new Error('Toornament answered in an unexpected format.');
  const r = isObj(json.range) ? json.range : {};
  const total = typeof r.total === 'number' ? r.total : json.items.length;
  return { items: json.items, offset: typeof r.offset === 'number' ? r.offset : 0, total };
}

export interface ToornamentTournament {
  id: string;
  name: string;
  status: string; // pending | running | completed
  participantType: string; // single | team
  page: string; // public page
}

export function readTournament(json: unknown): ToornamentTournament {
  if (!isObj(json) || !str(json.id)) throw new Error('Toornament answered in an unexpected format.');
  const id = str(json.id);
  return { id, name: str(json.fullName) || str(json.name) || 'Untitled tournament', status: str(json.status), participantType: str(json.participantType), page: toornamentPage({ tournamentId: id }) };
}

export interface ToornamentStage {
  id: string;
  number: number;
  name: string;
  type: string; // Toornament's: single_elimination, double_elimination, pools, league, swiss…
  typeLabel: string;
  status: string; // pending | running | completed
  size: number | null; // slots
  supported: boolean;
  reason?: string; // why it can't be used, for HQ
}

const TYPE_LABELS: Record<string, string> = {
  single_elimination: 'Single elimination',
  double_elimination: 'Double elimination',
  pools: 'Groups (round robin)',
  bracket_groups: 'Bracket groups',
  league: 'League',
  swiss: 'Swiss',
  simple: 'Simple matches',
  gauntlet: 'Gauntlet',
  ffa_single_elimination: 'Free-for-all elimination',
  ffa_league: 'Free-for-all league',
  ffa_bracket_groups: 'Free-for-all bracket groups',
};

export const stageTypeLabel = (type: string) => TYPE_LABELS[type] ?? (type ? type.replace(/_/g, ' ') : 'Unknown format');

/** Can Field Desk run this stage? Only single elimination maps onto its bracket. */
export function stageSupport(type: string): { supported: boolean; reason?: string } {
  if (type === 'single_elimination') return { supported: true };
  const label = stageTypeLabel(type);
  const why =
    type === 'double_elimination'
      ? 'players get a second life in a losers’ bracket'
      : type === 'pools' || type === 'league' || type === 'bracket_groups'
        ? 'everyone plays several matches and is ranked in a table'
        : type === 'swiss'
          ? 'pairings are drawn round by round from the standings'
          : type.startsWith('ffa')
            ? 'more than two players meet in each match'
            : 'it isn’t a two-player knockout';
  return { supported: false, reason: `${label} can’t be run here — ${why}. Field Desk runs single-elimination brackets only; pick a single-elimination stage, or change the format on Toornament.` };
}

export function readStages(json: unknown): ToornamentStage[] {
  return readPage(json)
    .items.filter(isObj)
    .map((s) => {
      const type = str(s.type);
      const size = isObj(s.settings) && typeof s.settings.size === 'number' ? s.settings.size : null;
      return { id: str(s.id), number: typeof s.number === 'number' ? s.number : 0, name: str(s.name) || 'Stage', type, typeLabel: stageTypeLabel(type), status: str(s.status), size, ...stageSupport(type) };
    })
    .filter((s) => TOORNAMENT_ID.test(s.id))
    .sort((a, b) => a.number - b.number);
}

/** The stage to show first: the one in HQ's link, else the only one, else the first single-elimination one. */
export function pickStage(stages: ToornamentStage[], wanted?: string): ToornamentStage | null {
  return stages.find((s) => s.id === wanted) ?? (stages.length === 1 ? stages[0] : (stages.find((s) => s.supported) ?? stages[0] ?? null));
}

export interface ToornamentParticipant {
  id: string;
  name: string;
}

const clean = (name: string) => {
  const n = name.replace(/\s+/g, ' ').trim();
  return (n.length > MAX_NAME ? n.slice(0, MAX_NAME).trim() : n) || 'Unnamed participant';
};

export function readParticipants(json: unknown): ToornamentParticipant[] {
  return readPage(json)
    .items.filter(isObj)
    .map((p) => ({ id: str(p.id), name: clean(str(p.name) || (isObj(p.team) ? str(p.team.name) : '')) }));
}

/** Same name, ignoring case and spacing — how Toornament names are matched to the store's players. */
export const nameKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Names unique by nameKey: a repeat becomes "Name (2)" (Field Desk refuses two players with one name). */
function uniqueNames(names: string[]): { names: string[]; renamed: string[] } {
  const seen = new Map<string, number>();
  const renamed: string[] = [];
  const out = names.map((n) => {
    const k = nameKey(n);
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    if (count === 1) return n;
    let alt = `${n.slice(0, MAX_NAME - 5)} (${count})`;
    while (seen.has(nameKey(alt))) alt = `${alt}′`;
    seen.set(nameKey(alt), 1);
    renamed.push(n);
    return alt;
  });
  return { names: out, renamed: [...new Set(renamed)] };
}

/* ---------- the bracket ---------- */

export interface StageBracket {
  /** 'pairs' = Toornament's own first round, exactly; 'seeded' = only a list of names (seed 1…n). */
  mode: 'pairs' | 'seeded';
  /** Names in seed order. For 'pairs', the seed a slot would have in a standard bracket of that size. */
  players: string[];
  /** First-round pairings by name, null = BYE ('pairs' only). Length 1, 2, 4, 8… */
  pairs: [string | null, string | null][] | null;
  /** Why it's 'seeded' / can't be used, in HQ's words. Absent when the pairings are usable as they are. */
  problem?: string;
  /** Things worth knowing that don't block (renamed duplicates, results not copied, 3rd-place match…). */
  notes: string[];
  /** Matches Toornament already has results for. They are not copied: matches are run here. */
  played: number;
}

interface Node {
  id: string;
  branch: string;
  group: string;
  round: number;
  number: number; // the match's number within its round — Toornament draws a round top to bottom by it
  status: string;
  opponents: { position: number; participant: ToornamentParticipant | null; sourceType: string; sourceNode: string }[];
}

function readNodes(items: unknown[]): Node[] {
  return items.filter(isObj).map((n) => ({
    id: str(n.id),
    branch: str(n.branch) || 'wb',
    group: idOf(n.group),
    round: isObj(n.round) && typeof n.round.number === 'number' ? n.round.number : 0,
    number: typeof n.number === 'number' ? n.number : 0,
    status: str(n.status),
    // Array order is Toornament's drawing order (top side, then bottom). `position` is NOT: in the
    // same answer a match can list position 2 first, and a final's position 1 can be the lower half.
    opponents: (Array.isArray(n.opponents) ? n.opponents : []).filter(isObj).map((o, i) => ({
      position: typeof o.position === 'number' ? o.position : i + 1,
      participant: isObj(o.participant) && str(o.participant.id) ? { id: str(o.participant.id), name: clean(str(o.participant.name)) } : null,
      sourceType: str(o.sourceType ?? o.source_type) || 'none',
      sourceNode: idOf(o.sourceNode ?? o.source_node),
    })),
  }));
}

const seededFrom = (names: string[], problem: string, notes: string[], played: number): StageBracket => {
  const u = uniqueNames(names);
  if (u.renamed.length) notes.push(renamedNote(u.renamed));
  return { mode: 'seeded', players: u.names, pairs: null, problem, notes, played };
};
const renamedNote = (names: string[]) => `${names.map((n) => `“${n}”`).join(', ')} ${names.length === 1 ? 'appears' : 'appear'} more than once on Toornament — the repeats are numbered “(2)”. Rename them there if they’re different people.`;

/**
 * A single-elimination stage's bracket-nodes → the first round as pairs of names, or a seeded
 * list with the reason it isn't the exact bracket. `registered` (all of the tournament's
 * participants, Toornament's list order) is the fallback when nobody is placed in the stage yet.
 */
export function bracketFromNodes(nodeItems: unknown[], registered: ToornamentParticipant[], stage?: Pick<ToornamentStage, 'number' | 'status'>): StageBracket {
  const nodes = readNodes(nodeItems);
  const notes: string[] = [];
  const played = nodes.filter((n) => n.status === 'completed' && n.opponents.every((o) => o.participant)).length;
  if (played) notes.push(`Toornament already has ${played} result${played === 1 ? '' : 's'} for this stage. Results aren’t copied — the bracket starts fresh here and matches are recorded on match day.`);
  const wb = nodes.filter((n) => n.branch !== 'lb');
  if (nodes.some((n) => n.branch === 'lb')) notes.push('Toornament’s 3rd-place match isn’t part of the bracket here.');
  const fallback = (problem: string) => {
    const placed = leafOrder(wb);
    return placed.length ? seededFrom(placed, `${problem} You can still use the ${placed.length} placed players, seeded in Toornament’s bracket order.`, notes, played) : seededFrom(registered.map((p) => p.name), `${problem}${registered.length ? ` You can use the ${registered.length} registered participants instead, seeded in Toornament’s list order.` : ''}`, notes, played);
  };

  if (!wb.length) return fallback('Toornament hasn’t generated this stage’s bracket yet.');
  const groups = new Set(wb.map((n) => n.group));
  if (groups.size > 1) return fallback(`This stage has ${groups.size} separate brackets — Field Desk runs one per store.`);
  const byId = new Map(wb.map((n) => [n.id, n]));
  const fed = new Set(wb.flatMap((n) => n.opponents.filter((o) => o.sourceType === 'winner').map((o) => o.sourceNode)));
  const roots = wb.filter((n) => !fed.has(n.id));
  if (roots.length !== 1) return fallback('Toornament’s bracket for this stage isn’t one knockout tree.');

  // Walk from the final down, top opponent first (the order Toornament draws them in — see
  // readNodes), so first-round match i here is the i-th match from the top on Toornament's page
  // and each later match is fed by matches 2i and 2i+1 of the round before, as Toornament's is.
  // A node in round r covers 2^r first-round slots; a player placed straight into round r
  // (Toornament skips bye matches) fills the first slot of their half.
  let shape = '';
  const visited = new Set<string>();
  const expand = (n: Node, round: number): (ToornamentParticipant | null)[] => {
    if (visited.has(n.id) || n.round !== round || round < 1 || round > 9) return (shape ||= 'loop'), [];
    visited.add(n.id);
    const opps = n.opponents;
    if (opps.length !== 2) return (shape ||= 'not-duel'), [];
    const half = 2 ** (round - 1);
    return opps.flatMap((o) => {
      if (o.sourceType === 'winner') {
        const child = byId.get(o.sourceNode);
        if (!child) return (shape ||= 'missing'), [];
        return expand(child, round - 1);
      }
      if (o.sourceType !== 'none') return (shape ||= o.sourceType), [];
      return [o.participant, ...Array<null>(half - 1).fill(null)];
    });
  };
  const root = roots[0];
  const slots = expand(root, root.round);
  if (shape || !isPow2(slots.length) || slots.length < 2 || visited.size !== wb.length) return fallback('Toornament’s bracket for this stage has a shape Field Desk can’t copy.');

  const placedCount = slots.filter(Boolean).length;
  if (!placedCount) {
    const later = stage && stage.number > 1 ? ' If they come from an earlier stage, Refresh once that stage is finished.' : '';
    return fallback(`Nobody is placed in this stage on Toornament yet.${later}`);
  }
  if (placedCount < 2) return fallback('Only one player is placed in this stage on Toornament.');
  if (placedCount > MAX_PLAYERS) return { mode: 'seeded', players: [], pairs: null, problem: `${placedCount} players — Field Desk brackets hold up to ${MAX_PLAYERS}.`, notes, played };

  const u = uniqueNames(slots.filter((p): p is ToornamentParticipant => !!p).map((p) => p.name));
  if (u.renamed.length) notes.push(renamedNote(u.renamed));
  const nameOf = new Map<ToornamentParticipant, string>();
  slots.filter((p): p is ToornamentParticipant => !!p).forEach((p, i) => nameOf.set(p, u.names[i]));

  const pairs: [string | null, string | null][] = [];
  for (let i = 0; i < slots.length; i += 2) pairs.push([slots[i] ? nameOf.get(slots[i]!)! : null, slots[i + 1] ? nameOf.get(slots[i + 1]!)! : null]);
  // Seed = the slot's seed in a standard bracket of this size, so 02 Seeding shows Toornament's order.
  const order = seedOrder(slots.length);
  const players = slots
    .map((p, i) => ({ p, seed: order[i] }))
    .filter((x) => x.p)
    .sort((a, b) => a.seed - b.seed)
    .map((x) => nameOf.get(x.p!)!);

  const empty = pairs.findIndex(([a, b]) => !a && !b);
  if (empty >= 0) {
    return {
      mode: 'seeded',
      players,
      pairs: null,
      problem: `First-round match ${empty + 1} on Toornament has nobody in it (an empty slot — the stage has ${slots.length} slots for ${placedCount} players). A bracket here can’t hold an empty match: on Toornament, set the stage size to ${placedCount} or fill the slot, then Refresh — or use the ${placedCount} players seeded in Toornament’s bracket order.`,
      notes,
      played,
    };
  }
  const registeredOnly = registered.filter((r) => !slots.some((s) => s?.id === r.id));
  if (registeredOnly.length) notes.push(`${registeredOnly.length} registered on Toornament but not in this stage: ${registeredOnly.slice(0, 8).map((p) => p.name).join(', ')}${registeredOnly.length > 8 ? '…' : ''}. They aren’t added.`);
  if (stage && stage.status === 'pending' && stage.number > 1 && slots.some((s) => !s)) notes.push('Some slots are still empty. If they’re filled from an earlier stage, Refresh once that stage is finished.');
  return { mode: 'pairs', players, pairs, notes, played };
}

/** Placed participants in bracket order (first round first), for the seeded fallback. */
function leafOrder(nodes: Node[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...nodes].sort((a, b) => a.round - b.round || a.number - b.number)) {
    for (const o of n.opponents) {
      if (o.sourceType === 'none' && o.participant && !seen.has(o.participant.id)) {
        seen.add(o.participant.id);
        out.push(o.participant.name);
      }
    }
  }
  return out;
}

/* ---------- what the server returns ---------- */

export interface ToornamentFetch {
  link: ToornamentLink;
  tournament: ToornamentTournament;
  stages: ToornamentStage[];
  stage: ToornamentStage | null; // the one this answer is about
  participants: ToornamentParticipant[]; // registered, Toornament's list order (first 300)
  participantsTotal: number;
  bracket: StageBracket | null; // null when the stage can't be used (stage.reason says why) or there is none
  fetchedAt: string;
}

/* ---------- applying it to a store ---------- */

export interface ImportPlan {
  players: Player[]; // the store's new roster, seed order (then any walk-ins kept outside the bracket)
  pairs: [string | null, string | null][] | null; // by player id
  matched: Player[]; // already on the store's list (or a walk-in's registration) — id, phone and check-in kept
  added: Player[]; // new from Toornament — no phone, so they check in at the desk
  dropped: Player[]; // on the store's list but not in Toornament's bracket — removed (walk-ins: see onSpotMissing)
  onSpotFound: { entry: OnSpotEntry; player: Player }[]; // walk-ins Toornament has — what onspot.mark ticks off
  onSpotMissing: { entry: OnSpotEntry; player?: Player; kept: boolean }[]; // walk-ins not in Toornament's bracket (yet). player = on the list now; kept = stays on it, outside the bracket
}

/**
 * Toornament's names onto the store's players: the same name (ignoring case and spacing) keeps
 * that player's id, phone, in-game name and so their check-in; failing that, a Toornament name
 * that is a player's in-game name (participant names are often gamertags) does the same. Anyone
 * else is added without a phone. Goes to the server as one bracket.load { players, pairs } —
 * atomic, and refused if the store changed.
 *
 * Walk-ins (opts.onSpot = the store's day.onSpot): those on the list match like everyone else; a
 * registration whose player has since left the list (an earlier import) is matched last, by name
 * then IGN, and comes back with its id, phone and IGN. Walk-ins Toornament doesn't have are
 * reported in onSpotMissing, not silently dropped. With opts.keepOutside (pairs only — a seeded
 * list would draw them into the bracket) those still on the list stay on it, after the bracket's
 * players and in no pairing.
 */
export function planImport(bracket: Pick<StageBracket, 'players' | 'pairs'>, existing: Player[], opts: { onSpot?: OnSpotEntry[]; keepOutside?: boolean } = {}): ImportPlan {
  const onSpot = opts.onSpot ?? [];
  const ids = new Set(existing.map((p) => p.id));
  // Registrations whose player isn't on the list any more: matchable, after everyone who is.
  const restored: Player[] = [];
  const restoredFor = (e: OnSpotEntry) => restored.find((r) => r.id === e.playerId || nameKey(r.name) === nameKey(e.name));
  for (const e of onSpot) {
    if (onSpotPlayer(existing, e) || ids.has(e.playerId) || restoredFor(e)) continue;
    const r: Player = { id: e.playerId, name: e.name.replace(/\s+/g, ' ').trim(), seed: 0 };
    if (e.phone) r.phone = e.phone;
    if (e.ign) r.ign = e.ign;
    restored.push(r);
  }
  for (const r of restored) ids.add(r.id);
  const byName = (list: Player[]) => new Map(list.map((p) => [nameKey(p.name), p]));
  const byIgn = (list: Player[]) => {
    const m = new Map<string, Player>();
    for (const p of list) if (p.ign && !m.has(nameKey(p.ign))) m.set(nameKey(p.ign), p);
    return m;
  };
  const used = new Set<string>();
  const matched: Player[] = [];
  const added: Player[] = [];
  const idByName = new Map<string, string>();
  // Names first, for every Toornament name — so a gamertag that happens to be someone's IGN
  // can't take a player whose own name comes later in the list. Then in-game names; then the
  // same two for walk-ins no longer on the list.
  const found = new Map<number, Player>();
  for (const by of [byName(existing), byIgn(existing), byName(restored), byIgn(restored)])
    bracket.players.forEach((name, i) => {
      const old = found.has(i) ? undefined : by.get(nameKey(name));
      if (!old || used.has(old.id)) return;
      used.add(old.id);
      found.set(i, old);
    });
  const players = bracket.players.map((name, i): Player => {
    const old = found.get(i);
    if (old) {
      const p: Player = { id: old.id, name: old.name, seed: i + 1 };
      if (old.phone) p.phone = old.phone;
      if (old.ign) p.ign = old.ign;
      matched.push(p);
      idByName.set(name, p.id);
      return p;
    }
    let id = playerIdFor(undefined, name);
    if (ids.has(id)) id = playerIdFor(undefined, `${name} (toornament)`); // a hash clash with another player's id
    ids.add(id);
    const p: Player = { id, name: name.replace(/\s+/g, ' ').trim(), seed: i + 1 };
    added.push(p);
    idByName.set(name, id);
    return p;
  });
  const pairs = bracket.pairs ? bracket.pairs.map(([a, b]) => [a === null ? null : idByName.get(a)!, b === null ? null : idByName.get(b)!] as [string | null, string | null]) : null;

  const onSpotFound: ImportPlan['onSpotFound'] = [];
  const onSpotMissing: ImportPlan['onSpotMissing'] = [];
  const walkIns = new Set<string>();
  const keep = !!opts.keepOutside && !!pairs;
  for (const entry of onSpot) {
    const now = onSpotPlayer(existing, entry);
    const id = now?.id ?? restoredFor(entry)?.id;
    if (id) walkIns.add(id);
    const inPlan = id ? players.find((p) => p.id === id) : undefined;
    if (inPlan) onSpotFound.push({ entry, player: inPlan });
    // Ticked off already and no longer on the list: nothing left to warn about.
    else if (now || !entry.toornament) onSpotMissing.push({ entry, player: now, kept: keep && !!now });
  }
  for (const m of onSpotMissing) if (m.kept && !players.some((p) => p.id === m.player!.id)) players.push({ ...m.player!, seed: players.length + 1 });
  return { players, pairs, matched, added, dropped: existing.filter((p) => !used.has(p.id) && !walkIns.has(p.id)), onSpotFound, onSpotMissing };
}

/** True once a real match has been called or played (bracket.load / players.set are refused then). */
export const underWay = (store: Store) => store.day.matches.some((m) => !m.bye && m.status !== 'pending');

