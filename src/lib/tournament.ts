/*
 * Tournament commands (match.start / finish / undo, bracket.load / reset / place, stations.set, the
 * players / seeding commands, and on-the-spot registration). Pure handlers over one store's match day — run by the server inside its commit and
 * optimistically by the client. See src/lib/commands.ts.
 *
 * How `base` is used:
 *   bracket.load / bracket.reset / bracket.place — destructive: `base` must equal the current day version,
 *     so a device that hasn't seen the latest bracket can't replace, wipe or re-slot it.
 *     bracket.place with `swap` moves a player who already has a first-round slot: the two slots trade occupants.
 *   stations.set / match.start / match.finish / match.undo / players.onspot / players.edit / onspot.mark / onspot.remove / winners.set / winners.manual / winners.clear —
 *     `base` is informational only.
 *     These are checked against the *current* state (station free, players checked in and
 *     not busy, match in the right status, nothing downstream started), which is the real
 *     guard. A strict version check would turn every unrelated result on another station
 *     into a spurious conflict. Several desks may register walk-ins at once, so players.onspot
 *     is checked against the current list (phone and name not already on it) the same way.
 *     Check-ins are plain field edits and never bump the version.
 * Every successful command bumps `day.version` by exactly 1.
 */
import type { Match, MatchDay, OnSpotEntry, Player, Store, WinnerDetails, Winners } from './types.ts';
import { CommandError, type Command, type CommandContext, type Role } from './command-types.ts';
import { buildBracket, isPow2, matchNo, nextOf, reopened, resolve } from './bracket.ts';
import { onSpotPlayer } from './onspot.ts';
import { cleanIgn, isPhone, MAX_IGN, normalizePhone, playerIdFor } from './phone.ts';
import { cleanWinnerInput, finalOf, finalResult } from './winnerInput.ts';

export const TOURNAMENT_COMMANDS: Record<string, Role[]> = {
  // HQ owns the bracket: it loads players from its sheet / CSV / tournament site. Admins run the day.
  'bracket.load': ['super'],
  'bracket.reset': ['super'],
  'players.set': ['super'],
  'players.seed': ['super'],
  'bracket.build': ['super'],
  'bracket.place': ['super'], // a first-round slot, before that match is played — e.g. a late walk-in HQ has put on Toornament; `swap` trades two slots
  'stations.set': ['super', 'admin'],
  'match.start': ['super', 'admin'],
  'match.finish': ['super', 'admin'],
  'match.undo': ['super', 'admin'],
  // Walk-ins: the desk registers them (they join the list, checked in); HQ ticks them off once on Toornament.
  'players.onspot': ['super', 'admin'],
  'onspot.mark': ['super'],
  'onspot.remove': ['super'], // HQ deletes registrations (test data, mistakes)
  // Correcting a player: HQ changes name, in-game name and number; the desk only gives a player who has none a number (and sets the in-game name).
  'players.edit': ['super', 'admin'],
  // The admin collects the winner's and runner-up's details after the final; HQ may correct them.
  'winners.set': ['super', 'admin'],
  'winners.manual': ['super'], // HQ types them for a store whose bracket ran elsewhere (Toornament) — no final needed
  'winners.clear': ['super'], // the only way to remove them: test data, or details saved for a final that was later reset
};

const conflict = (msg: string) => new CommandError('conflict', msg);
const invalid = (msg: string) => new CommandError('invalid', msg);

export function tournamentCommand(store: Store, cmd: Command, ctx: CommandContext): Store {
  const day = store.day;
  const version = day.version ?? 0;
  let next: MatchDay;
  switch (cmd.type) {
    case 'bracket.load':
      next = load(day, version, cmd, ctx);
      break;
    case 'bracket.reset':
      // The bracket only: players, seeds and check-ins stay, so HQ can re-seed and build again.
      // day.winners stays too — prize details are never lost to a reset (see setWinners).
      if (cmd.base !== version) throw conflict(staleMsg);
      next = { ...day, matches: [] };
      break;
    case 'players.set': {
      if (cmd.base !== version) throw conflict(staleMsg);
      underway(day, 'changing the players');
      const players = cleanPlayers(cmd.players, 0);
      next = { ...day, ...keptCheckIns(day, players), players, matches: [] };
      break;
    }
    case 'players.seed':
      if (cmd.base !== version) throw conflict(staleMsg);
      underway(day, 'changing the seeding');
      next = { ...day, players: seeded(day.players, cmd.order), matches: [] };
      break;
    case 'bracket.build': {
      if (cmd.base !== version) throw conflict(staleMsg);
      underway(day, 'building a new bracket');
      if (day.players.length < 2) throw invalid('A bracket needs at least 2 players — add them in Players first.');
      const players = [...day.players].sort((a, b) => a.seed - b.seed);
      const stations = cmd.stations ?? day.stations;
      if (!Number.isInteger(stations) || stations < 1 || stations > 64) throw invalid('Stations must be a whole number 1–64.');
      next = { ...day, matches: buildBracket(players, checkedPairs(players, cmd.pairs, (p) => isWalkIn(day, p)), ctx.commandId), stations };
      break;
    }
    case 'bracket.place':
      if (cmd.base !== version) throw conflict(staleMsg);
      next = place(day, cmd);
      break;
    case 'stations.set':
      next = setStations(day, cmd.count);
      break;
    case 'match.start':
      next = start(day, cmd.matchId, cmd.station, ctx);
      break;
    case 'match.finish':
      next = finish(day, cmd, ctx);
      break;
    case 'match.undo':
      next = undo(day, cmd.matchId);
      break;
    case 'players.onspot':
      next = onSpot(day, cmd, ctx);
      break;
    case 'players.edit':
      next = editPlayer(day, cmd, ctx);
      break;
    case 'onspot.mark':
      next = markOnSpot(day, cmd, ctx);
      break;
    case 'onspot.remove':
      next = removeOnSpot(day, cmd);
      break;
    case 'winners.set':
      next = setWinners(day, cmd, ctx);
      break;
    case 'winners.manual':
      next = manualWinners(day, cmd, ctx);
      break;
    case 'winners.clear':
      next = clearWinners(day);
      break;
    default:
      throw invalid(`${(cmd as { type: string }).type} isn’t a tournament command`);
  }
  if (next === day) return store; // a command already in this view (only on a device; the server dedupes by command id)
  return { ...store, day: { ...next, version: version + 1 } };
}

const staleMsg = 'The bracket changed on another device since this page loaded. Check the latest bracket, then try again.';

/* ---------- helpers ---------- */

const names = (day: MatchDay) => new Map(day.players.map((p) => [p.id, p.name]));
const who = (day: MatchDay, id: string | null) => (id ? (names(day).get(id) ?? 'Unknown player') : 'TBD');
const label = (day: MatchDay, m: Match) => `M${matchNo(m, day.matches)}`;
const pairing = (day: MatchDay, m: Match) => `${who(day, m.a)} vs ${who(day, m.b)}`;

function find(day: MatchDay, id: string) {
  const m = day.matches.find((x) => x.id === id);
  if (!m) throw conflict('That match is no longer in this bracket — it was reset or reloaded on another device.');
  return m;
}

/** Replace one match, re-resolve downstream, and refuse anything that would re-point a started match. */
const withMatch = (day: MatchDay, changed: Match) => withMatches(day, [changed]);

/** The same for several matches at once — downstream is re-resolved once, after all of them have changed. */
function withMatches(day: MatchDay, changed: Match[]): MatchDay {
  const by = new Map(changed.map((c) => [c.id, c]));
  const { matches, disturbed } = resolve(day.matches.map((x) => by.get(x.id) ?? x));
  if (disturbed.length) {
    const d = disturbed[0];
    throw conflict(`${label(day, d)} (${pairing(day, d)}) has already ${d.status === 'live' ? 'started' : 'been played'} — undo that first.`);
  }
  return { ...day, matches };
}

/* ---------- players, seeding, bracket.load ---------- */

/** Refuse roster / seeding / bracket changes once a real match has been played or called. */
function underway(day: MatchDay, what: string) {
  if (day.matches.some((m) => !m.bye && m.status !== 'pending'))
    throw conflict(`Matches are already under way here — reset the bracket before ${what}.`);
}

/** Validate a roster: unique ids / names / seeds, phones as digits, in-game names ≤ MAX_IGN. `min` players (0 for a roster, 2 for a bracket). */
function cleanPlayers(players: Player[], min: number): Player[] {
  if (!Array.isArray(players) || players.length < min || players.length > 256) throw invalid(min ? `A bracket needs ${min}–256 players.` : 'Up to 256 players.');
  const ids = new Set<string>();
  const nameKeys = new Set<string>();
  const seeds = new Set<number>();
  const clean: Player[] = players.map((p) => {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 64) throw invalid('Every player needs an id.');
    const name = typeof p.name === 'string' ? p.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 80) throw invalid('Every player needs a name (up to 80 characters).');
    if (!Number.isInteger(p.seed) || p.seed < 1) throw invalid(`${name} needs a seed number.`);
    if (ids.has(p.id)) throw invalid(`Player id ${p.id} appears twice.`);
    if (nameKeys.has(name.toLowerCase())) throw invalid(`“${name}” appears twice.`);
    if (seeds.has(p.seed)) throw invalid(`Seed ${p.seed} is given to two players.`);
    if (p.phone !== undefined && (typeof p.phone !== 'string' || !/^\d{6,15}$/.test(p.phone))) throw invalid(`${name}’s phone number should be 6–15 digits.`);
    if (p.ign !== undefined && typeof p.ign !== 'string') throw invalid(`${name}’s in-game name should be text.`);
    const ign = p.ign === undefined ? '' : cleanIgn(p.ign);
    if (ign.length > MAX_IGN) throw invalid(`${name}’s in-game name is longer than ${MAX_IGN} characters.`);
    ids.add(p.id);
    nameKeys.add(name.toLowerCase());
    seeds.add(p.seed);
    // The phone travels with the player: it's how they find themselves at QR check-in. The
    // in-game name is for staff only (lists, search) — the id never depends on it.
    const out: Player = { id: p.id, name, seed: p.seed };
    if (p.phone) out.phone = p.phone;
    if (ign) out.ign = ign;
    return out;
  });
  return clean;
}

/** Players kept across a roster change (stable ids) keep their check-in and how it was made. */
function keptCheckIns(day: MatchDay, players: Player[]) {
  const ids = new Set(players.map((p) => p.id));
  const checkIn: Record<string, string> = {};
  const checkInSource: Record<string, 'self' | 'staff'> = {};
  for (const [id, at] of Object.entries(day.checkIn)) if (ids.has(id)) checkIn[id] = at;
  for (const [id, src] of Object.entries(day.checkInSource ?? {})) if (ids.has(id)) checkInSource[id] = src;
  return { checkIn, checkInSource };
}

/** New seeds from an order that must list every current player exactly once. */
function seeded(players: Player[], order: string[]): Player[] {
  const byId = new Map(players.map((p) => [p.id, p]));
  if (order.length !== players.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id)))
    throw conflict('The player list changed since this seeding was made — check the players, then seed again.');
  return order.map((id, i) => ({ ...byId.get(id)!, seed: i + 1 }));
}

function checkedPairs(clean: Player[], given: [string | null, string | null][] | null | undefined, outside: (p: Player) => boolean = () => false): [string | null, string | null][] | null {
  if (!given) return null;
  const ids = new Set(clean.map((p) => p.id));
  if (!Array.isArray(given) || !isPow2(given.length)) throw invalid('Pairings must number 1, 2, 4, 8, 16…');
  const placed = new Set<string>();
  const pairs = given.map((pr, i) => {
    if (!Array.isArray(pr) || pr.length !== 2) throw invalid(`Pairing ${i + 1} must have exactly two sides.`);
    const [a, b] = pr as [string | null, string | null];
    if (!a && !b) throw invalid(`Pairing ${i + 1} is BYE vs BYE.`);
    for (const s of [a, b]) {
      if (s === null) continue;
      if (typeof s !== 'string' || !ids.has(s)) throw invalid(`Pairing ${i + 1} names a player who isn’t on the roster.`);
      if (placed.has(s)) throw invalid(`${clean.find((p) => p.id === s)!.name} is in two pairings.`);
      placed.add(s);
    }
    return [a, b] as [string | null, string | null];
  });
  // Walk-ins HQ hasn't put on Toornament yet may stay on the list outside the bracket; anyone else missing is a mistake.
  const missing = clean.filter((p) => !placed.has(p.id) && !outside(p));
  if (missing.length) throw invalid(`${missing.map((p) => p.name).join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} in any pairing.`);
  return pairs;
}

/** Registered at the desk on the day (day.onSpot) — by id, else the same phone, else the same name. */
function isWalkIn(day: MatchDay, p: Player) {
  const name = p.name.replace(/\s+/g, ' ').trim().toLowerCase();
  return (day.onSpot ?? []).some((e) => e.playerId === p.id || (!!e.phone && e.phone === p.phone) || e.name.replace(/\s+/g, ' ').trim().toLowerCase() === name);
}

/** bracket.load = players.set + bracket.build in one step (campaign-wide imports, the demo). */
function load(day: MatchDay, version: number, cmd: Extract<Command, { type: 'bracket.load' }>, ctx: CommandContext): MatchDay {
  if (cmd.base !== version) throw conflict(staleMsg);
  underway(day, 'loading a new one');
  const clean = cleanPlayers(cmd.players, 2);
  const stations = cmd.stations ?? day.stations;
  if (!Number.isInteger(stations) || stations < 1 || stations > 64) throw invalid('Stations must be a whole number 1–64.');
  return { ...day, ...keptCheckIns(day, clean), players: clean, matches: buildBracket(clean, checkedPairs(clean, cmd.pairs, (p) => isWalkIn(day, p)), ctx.commandId), stations };
}

/* ---------- on-the-spot registration ---------- */

/** Most players a store's list — and its record of on-the-spot registrations — may hold. */
export const MAX_PLAYERS = 256;
const MAX_NAME = 80;

const nameKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Who on the list a walk-in clashes with: the same phone (the same person — check them in
 * instead) or the same name (maybe the same person; the admin decides). The desk form asks
 * before it sends; the handler refuses an unconfirmed clash, e.g. from another desk meanwhile.
 */
export function onSpotClash(day: MatchDay, name: string, phone?: string): { kind: 'phone' | 'name' | 'phone-end'; player: Player } | null {
  const tel = phone ? normalizePhone(phone) : '';
  const byPhone = tel ? day.players.find((p) => p.phone === tel) : undefined;
  if (byPhone) return { kind: 'phone', player: byPhone };
  const key = nameKey(name);
  const byName = key ? day.players.find((p) => nameKey(p.name) === key) : undefined;
  if (byName) return { kind: 'name', player: byName };
  // A field admin's device holds only the last 4 digits of players not checked in yet (Player.phoneEnd):
  // a match there is "might be on the list already", never proof — the server, which has every number, decides.
  const byEnd = tel ? day.players.find((p) => !p.phone && p.phoneEnd && tel.endsWith(p.phoneEnd)) : undefined;
  return byEnd ? { kind: 'phone-end', player: byEnd } : null;
}

/** "Asha R. (2)", or (3)… — the first that's free on the list, within the name length limit. */
export function differentName(day: MatchDay, name: string): string {
  const taken = new Set(day.players.map((p) => nameKey(p.name)));
  for (let n = 2; ; n++) {
    const tag = ` (${n})`;
    const c = `${name.slice(0, MAX_NAME - tag.length).trim()}${tag}`;
    if (!taken.has(nameKey(c))) return c;
  }
}

/** players.onspot: the walk-in joins the list (next seed), checked in, and is recorded for HQ. Never touches the bracket. */
function onSpot(day: MatchDay, cmd: Extract<Command, { type: 'players.onspot' }>, ctx: CommandContext): MatchDay {
  const record = day.onSpot ?? [];
  const entryId = `os-${ctx.commandId}`;
  if (record.some((e) => e.id === entryId)) return day; // already applied (a device re-running its own pending command)
  if (day.matches.length > 0 && ctx.actor.role !== 'super') throw conflict('The bracket is out, so on-spot registration is closed here. Ask HQ to add a player.');
  const raw = typeof cmd.name === 'string' ? cmd.name.replace(/\s+/g, ' ').trim() : '';
  if (!raw) throw invalid('Type the player’s name.');
  if (raw.length > MAX_NAME) throw invalid(`Keep the name to ${MAX_NAME} characters.`);
  if (cmd.phone !== undefined && typeof cmd.phone !== 'string') throw invalid('The phone number should be text.');
  const typed = (cmd.phone ?? '').trim();
  if (typed && !isPhone(typed)) throw invalid('That phone number doesn’t look right — type 8–15 digits, or leave it empty.');
  const phone = typed ? normalizePhone(typed) : '';
  if (cmd.ign !== undefined && typeof cmd.ign !== 'string') throw invalid('The in-game name should be text.');
  const ign = cleanIgn(cmd.ign ?? '');
  if (ign.length > MAX_IGN) throw invalid(`Keep the in-game name to ${MAX_IGN} characters.`);
  if (day.players.length >= MAX_PLAYERS) throw conflict(`The list is full (${MAX_PLAYERS} players) — no one more can be added here. Ask HQ.`);
  if (record.length >= MAX_PLAYERS) throw conflict(`${MAX_PLAYERS} players have been registered on the spot here already — ask HQ.`);

  let name = raw;
  const clash = onSpotClash(day, raw, phone);
  if (clash?.kind === 'phone') {
    const p = clash.player;
    throw conflict(`The number ending ${phone.slice(-4)} is already on the list as ${p.name}${day.checkIn[p.id] ? ' (already checked in)' : ' — check them in instead'}.`);
  }
  if (clash?.kind === 'name') {
    if (cmd.sameName !== 'different')
      throw conflict(`${clash.player.name} is already on the list — if it’s them, check them in instead; if it’s someone else with the same name, register them as a different person.`);
    name = differentName(day, raw);
  }

  // Same id as an HQ or Toornament import of this person would give, so a later import keeps the check-in.
  const ids = new Set(day.players.map((p) => p.id));
  const base = playerIdFor(phone || undefined, name);
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  const seed = day.players.reduce((max, p) => Math.max(max, p.seed), 0) + 1;
  const player: Player = { id, name, seed };
  if (phone) player.phone = phone;
  if (ign) player.ign = ign;
  const entry: OnSpotEntry = { id: entryId, playerId: id, name, at: ctx.now, by: ctx.actor.name };
  if (phone) entry.phone = phone;
  if (ign) entry.ign = ign;
  return {
    ...day,
    players: [...day.players, player],
    checkIn: { ...day.checkIn, [id]: ctx.now },
    checkInSource: { ...day.checkInSource, [id]: 'staff' },
    onSpot: [...record, entry],
  };
}

/**
 * players.edit: HQ corrects a player's name, in-game name or number. The desk (admins, store teams) may
 * only give a player who has no number one, and set the in-game name — the server has every number, so
 * "has none" is judged on its state. Id, seed, check-in and the bracket are untouched, so it works at any
 * time. A player's on-the-spot registration follows the edit, so a later Toornament import that brings the
 * walk-in back has the new details. Nothing to change = the same day (no version bump).
 */
function editPlayer(day: MatchDay, cmd: Extract<Command, { type: 'players.edit' }>, ctx: CommandContext): MatchDay {
  const old = day.players.find((p) => p.id === cmd.playerId);
  if (!old) throw conflict('That player isn’t on the list any more — the list changed on another device.');
  const hq = ctx.actor.role === 'super';
  const out: Player = { ...old };
  const changed: { name?: string; phone?: string; ign?: string } = {}; // '' = removed

  if (cmd.name !== undefined) {
    if (typeof cmd.name !== 'string') throw invalid('The name should be text.');
    const name = cmd.name.replace(/\s+/g, ' ').trim();
    if (!name) throw invalid('Type the player’s name.');
    if (name.length > MAX_NAME) throw invalid(`Keep the name to ${MAX_NAME} characters.`);
    if (name !== old.name) {
      if (!hq) throw new CommandError('forbidden', 'Only HQ can rename a player.');
      const same = day.players.find((p) => p.id !== old.id && nameKey(p.name) === nameKey(name));
      if (same) throw conflict(`${same.name} is already on the list — a name can only be there once.`);
      out.name = changed.name = name;
    }
  }
  if (cmd.phone !== undefined) {
    if (typeof cmd.phone !== 'string') throw invalid('The phone number should be text.');
    const typed = cmd.phone.trim();
    if (typed && !isPhone(typed)) throw invalid('That phone number doesn’t look right — type 8–15 digits, or leave it empty to remove it.');
    const phone = typed ? normalizePhone(typed) : '';
    if (phone !== (old.phone ?? '')) {
      if (!hq && (old.phone || old.phoneEnd)) throw new CommandError('forbidden', 'Only HQ can change a number that’s already on the list.');
      const other = phone ? day.players.find((p) => p.id !== old.id && p.phone === phone) : undefined;
      if (other) throw conflict(`That number is already on the list as ${other.name}.`);
      if (phone) out.phone = phone;
      else delete out.phone;
      changed.phone = phone;
    }
  }
  if (cmd.ign !== undefined) {
    if (typeof cmd.ign !== 'string') throw invalid('The in-game name should be text.');
    const ign = cleanIgn(cmd.ign);
    if (ign.length > MAX_IGN) throw invalid(`Keep the in-game name to ${MAX_IGN} characters.`);
    if (ign !== (old.ign ?? '')) {
      if (ign) out.ign = ign;
      else delete out.ign;
      changed.ign = ign;
    }
  }
  if (!Object.keys(changed).length) return day;

  const onSpot = day.onSpot?.map((e) => {
    if (onSpotPlayer(day.players, e)?.id !== old.id) return e;
    const entry: OnSpotEntry = { ...e };
    if (changed.name !== undefined) entry.name = changed.name;
    if (changed.phone !== undefined) {
      if (changed.phone) entry.phone = changed.phone;
      else delete entry.phone;
    }
    if (changed.ign !== undefined) {
      if (changed.ign) entry.ign = changed.ign;
      else delete entry.ign;
    }
    return entry;
  });
  return { ...day, players: day.players.map((p) => (p === old ? out : p)), ...(onSpot ? { onSpot } : {}) };
}

/** onspot.mark: HQ has (done) or hasn't yet (not done) put this walk-in on Toornament. */
function markOnSpot(day: MatchDay, cmd: Extract<Command, { type: 'onspot.mark' }>, ctx: CommandContext): MatchDay {
  const record = day.onSpot ?? [];
  const e = record.find((x) => x.id === cmd.entryId);
  if (!e) throw conflict('That on-the-spot registration isn’t on this store any more.');
  const next: OnSpotEntry = { ...e };
  if (!cmd.done) delete next.toornament;
  else next.toornament ??= ctx.now; // marking twice keeps the first time
  return { ...day, onSpot: record.map((x) => (x.id === e.id ? next : x)) };
}

/**
 * onspot.remove: HQ deletes registrations. By default only the record goes — the player (who may be
 * real and checked in) stays on the list for HQ to remove there. With alsoPlayers the players those
 * entries point at leave the list too (and their check-in), which is refused once matches are
 * under way; a bracket that had one of them is cleared, like players.set. Unknown ids are a
 * conflict (another HQ device removed them); a retry of the same command is deduped by id upstream.
 */
function removeOnSpot(day: MatchDay, cmd: Extract<Command, { type: 'onspot.remove' }>): MatchDay {
  const record = day.onSpot ?? [];
  const ids = [...new Set(cmd.entryIds)];
  const unknown = ids.filter((id) => !record.some((e) => e.id === id));
  if (unknown.length)
    throw conflict(ids.length === 1 ? 'That on-the-spot registration isn’t on this store any more.' : `${unknown.length} of these registrations aren’t on this store any more — they were removed on another device. Refresh and try again.`);
  const drop = new Set(ids);
  const kept = record.filter((e) => !drop.has(e.id));
  const next: MatchDay = { ...day, onSpot: kept };
  if (!cmd.alsoPlayers) return next;
  const keep = new Set(kept.flatMap((e) => onSpotPlayer(day.players, e)?.id ?? []));
  const leaving = new Set(record.filter((e) => drop.has(e.id)).flatMap((e) => onSpotPlayer(day.players, e)?.id ?? []).filter((id) => !keep.has(id)));
  if (!leaving.size) return next;
  underway(day, 'removing them from the player list');
  const players = day.players.filter((p) => !leaving.has(p.id));
  const inBracket = day.matches.some((m) => (m.a && leaving.has(m.a)) || (m.b && leaving.has(m.b)));
  return { ...next, ...keptCheckIns(day, players), players, matches: inBracket ? [] : day.matches };
}

/* ---------- winners.set ---------- */

/**
 * winners.set: the admin's winner / runner-up details after the final. Who they are comes from the
 * final, never from the command. Saving again updates (`at` keeps the first time). Like the other
 * day-of commands `base` is informational: several devices may fill this in, and the real guard is
 * the final itself. Everything that rewrites the bracket or players (bracket.reset / load / build,
 * players.set) leaves day.winners alone — prize details must never be lost; a record whose final
 * no longer matches is flagged (winnersState), not deleted.
 */
function setWinners(day: MatchDay, cmd: Extract<Command, { type: 'winners.set' }>, ctx: CommandContext): MatchDay {
  if (day.winners?.manual && ctx.actor.role !== 'super') throw conflict('HQ entered this store’s winners by hand — ask HQ to change them.');
  const final = finalOf(day.matches);
  const result = finalResult(day.matches);
  if (!final || !result) throw conflict('Record the final first — the winner and runner-up come from its result.');
  const w = cleanWinnerInput(cmd.winner, 'Winner');
  if (!w.ok) throw invalid(w.error);
  const r = cleanWinnerInput(cmd.runnerUp, 'Runner-up');
  if (!r.ok) throw invalid(r.error);
  const winner: WinnerDetails = { playerId: result.winner, ...w.value };
  const runnerUp: WinnerDetails = { playerId: result.runnerUp, ...r.value };
  const winners: Winners = { winner, runnerUp, finalMatchId: final.id, at: day.winners?.at ?? ctx.now, updatedAt: ctx.now, by: ctx.actor.name };
  return { ...day, winners };
}

/* ---------- winners.manual ---------- */

/**
 * winners.manual: HQ types the winner and runner-up for a store whose bracket ran elsewhere, so nothing
 * is checked against the bracket (finalMatchId and playerId stay ''). The winner needs a real name; the
 * runner-up may be left empty. Saving again updates (`at` keeps the first time). `base` is informational.
 * The desk can’t overwrite a manual record with winners.set; HQ can (it then comes from the bracket).
 */
function manualWinners(day: MatchDay, cmd: Extract<Command, { type: 'winners.manual' }>, ctx: CommandContext): MatchDay {
  const w = cleanWinnerInput(cmd.winner, 'Winner');
  if (!w.ok) throw invalid(w.error);
  if (!w.value.realName) throw invalid('Type the winner’s name.');
  const r = cleanWinnerInput(cmd.runnerUp, 'Runner-up');
  if (!r.ok) throw invalid(r.error);
  const winners: Winners = { winner: { playerId: '', ...w.value }, runnerUp: { playerId: '', ...r.value }, finalMatchId: '', manual: true, at: day.winners?.at ?? ctx.now, updatedAt: ctx.now, by: ctx.actor.name };
  return { ...day, winners };
}

/* ---------- winners.clear ---------- */

/**
 * winners.clear: HQ drops the saved winner / runner-up details. The bracket, players and check-ins
 * are not touched, so the admin's match-day page offers "Collect winner details" again once the final
 * is done. `base` is informational, like winners.set; the real guard is that there is something to clear.
 */
function clearWinners(day: MatchDay): MatchDay {
  if (!day.winners) throw conflict('There are no winner details saved for this store.');
  const { winners: _gone, ...rest } = day;
  return rest;
}

/* ---------- bracket.place ---------- */

/**
 * bracket.place: HQ puts a player into a first-round slot, or empties it, while that match hasn't
 * been played (pending, or a bye). The match is rebuilt as "not played" so resolve re-derives the bye
 * and what it feeds; withMatch refuses if that would re-point a match that has started. The player
 * who leaves the slot stays on the list, and check-ins are untouched.
 * With `swap`, a player who already has a first-round slot moves here and whoever was here (or nobody)
 * takes their old slot; both matches must be changeable and neither may be left empty.
 */
function place(day: MatchDay, cmd: Extract<Command, { type: 'bracket.place' }>): MatchDay {
  const m = find(day, cmd.matchId);
  if (cmd.side !== 'a' && cmd.side !== 'b') throw invalid('Pick a side of the match.');
  if (cmd.playerId !== null && typeof cmd.playerId !== 'string') throw invalid('Pick a player, or leave the slot empty.');
  changeable(day, m);
  if (cmd.playerId === m[cmd.side]) return day; // already how it is
  if (cmd.playerId === null) {
    if (!(cmd.side === 'a' ? m.b : m.a)) throw invalid('A match needs at least one player.');
  } else {
    const id = cmd.playerId;
    if (!day.players.some((p) => p.id === id)) throw conflict('That player isn’t on the list any more — the list changed on another device.');
    const into = day.matches.find((x) => x.a === id || x.b === id);
    if (into && cmd.swap) return swapSlots(day, m, cmd.side, into, id);
    if (into) throw conflict(`${who(day, id)} is already in ${label(day, into)}. Empty that slot first.`);
  }
  return withMatch(day, { ...reopened(m), [cmd.side]: cmd.playerId });
}

/** A first-round match whose players can still change: not played yet (or a bye). */
function changeable(day: MatchDay, m: Match) {
  const L = label(day, m);
  if (m.round !== 0) throw conflict(`${L} isn’t a first-round match — only first-round slots can be changed.`);
  if (m.status !== 'pending' && !m.bye) throw conflict(`${L} has already ${m.status === 'live' ? 'started' : 'been played'} — undo it first, or change a match that hasn’t been played.`);
}

/** bracket.place with `swap`: player `id`, now in a slot of `from`, trades places with whoever (or nobody) is in `m[side]`. */
function swapSlots(day: MatchDay, m: Match, side: 'a' | 'b', from: Match, id: string): MatchDay {
  changeable(day, from);
  const fromSide = from.a === id ? 'a' : 'b';
  if (from.id === m.id) return withMatch(day, { ...reopened(m), a: m.b, b: m.a }); // top and bottom of one match
  const other = m[side];
  if (!other && !(fromSide === 'a' ? from.b : from.a)) throw invalid('A match needs at least one player.');
  return withMatches(day, [
    { ...reopened(m), [side]: id },
    { ...reopened(from), [fromSide]: other },
  ]);
}

/* ---------- stations.set ---------- */

function setStations(day: MatchDay, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw invalid('Stations must be a whole number 1–64.');
  const above = day.matches.filter((m) => m.status === 'live' && (m.station ?? 0) > count).sort((x, y) => (y.station ?? 0) - (x.station ?? 0));
  if (above.length) {
    const m = above[0];
    throw conflict(`Station ${m.station} is running ${label(day, m)} (${pairing(day, m)}). Finish or cancel it before going down to ${count} station${count === 1 ? '' : 's'}.`);
  }
  return { ...day, stations: count };
}

/* ---------- match.start ---------- */

function start(day: MatchDay, matchId: string, station: number, ctx: CommandContext): MatchDay {
  const m = find(day, matchId);
  const L = label(day, m);
  if (m.status === 'live') throw conflict(`${L} is already being played on station ${m.station}.`);
  if (m.status === 'done') throw conflict(`${L} already has a result${m.winner ? ` — ${who(day, m.winner)} won` : ''}.`);
  if (m.bye || !m.a || !m.b) throw conflict(`${L} is still waiting on an earlier result.`);
  const missing = [m.a, m.b].filter((p) => !day.checkIn[p]);
  if (missing.length) throw conflict(`${missing.map((p) => who(day, p)).join(' and ')} ${missing.length === 1 ? 'hasn’t' : 'haven’t'} checked in yet.`);
  for (const p of [m.a, m.b]) {
    const busy = day.matches.find((x) => x.status === 'live' && x.id !== m.id && (x.a === p || x.b === p));
    if (busy) throw conflict(`${who(day, p)} is already playing ${label(day, busy)} on station ${busy.station}.`);
  }
  if (!Number.isInteger(station) || station < 1) throw invalid('Pick a station.');
  if (station > day.stations) throw conflict(`Station ${station} isn’t set up — this venue has ${day.stations} station${day.stations === 1 ? '' : 's'}.`);
  const taken = day.matches.find((x) => x.status === 'live' && x.station === station);
  if (taken) throw conflict(`Station ${station} is already running ${label(day, taken)} (${pairing(day, taken)}). Pick another station.`);
  return withMatch(day, { ...reopened(m), status: 'live', station, startedAt: ctx.now });
}

/* ---------- match.finish ---------- */

function finish(day: MatchDay, cmd: Extract<Command, { type: 'match.finish' }>, ctx: CommandContext): MatchDay {
  const m = find(day, cmd.matchId);
  const L = label(day, m);
  if (m.status === 'done') throw conflict(`${L} already has a result${m.winner ? ` — ${who(day, m.winner)} won` : ''}. Undo it first to correct it.`);
  if (!m.a || !m.b) throw conflict(`${L} is still waiting on an earlier result.`);
  if (cmd.winner !== m.a && cmd.winner !== m.b) throw conflict(`${who(day, cmd.winner)} isn’t playing in ${L} (${pairing(day, m)}).`);
  const score = typeof cmd.score === 'string' ? cmd.score.trim() : '';
  if (score.length > 40) throw invalid('Keep the score short (40 characters).');
  const loser = cmd.winner === m.a ? m.b : m.a;
  if (m.status === 'pending') {
    if (!cmd.walkover) throw conflict(`${L} hasn’t started — call it to a station first.`);
    if (!day.checkIn[cmd.winner]) throw conflict(`${who(day, cmd.winner)} hasn’t checked in, so can’t advance by walkover.`);
    if (day.checkIn[loser]) throw conflict(`${who(day, loser)} has checked in — play the match instead of a walkover.`);
  }
  const done: Match = { ...m, winner: cmd.winner, status: 'done', endedAt: ctx.now, score, walkover: !!cmd.walkover };
  if (!done.walkover) delete done.walkover;
  return withMatch(day, done);
}

/* ---------- match.undo ---------- */

function undo(day: MatchDay, matchId: string): MatchDay {
  const m = find(day, matchId);
  const L = label(day, m);
  if (m.bye) throw conflict(`${L} is a bye — there's nothing to undo.`);
  if (m.status === 'pending') throw conflict(`${L} has no result to undo — it may already have been undone on another device.`);
  if (m.status === 'done') {
    const n = nextOf(m, day.matches);
    if (n && n.status !== 'pending') throw conflict(`${label(day, n)} (${pairing(day, n)}) has already ${n.status === 'live' ? 'started' : 'been played'} — undo that first.`);
  }
  // Score, walkover and times always go (audit F16): a replay must not inherit the old result.
  return withMatch(day, reopened(m));
}
