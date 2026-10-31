/*
 * The Toornament auto-check — the pure half. On a store's event day, from 12:30 India time, the
 * server (server/toornament-auto.ts) looks at the store's Toornament stage every 5 minutes; once the
 * players are placed in a single-elimination bracket it loads it exactly as HQ's "Use this bracket"
 * would (one bracket.load), then stops. This file holds the rules that both the server and HQ's
 * screens need: when a store is being checked, what counts as "the bracket is there", whether the
 * store's current bracket may be replaced, the command, and the one-line status HQ reads.
 *
 * Node-loadable: no browser APIs, explicit .ts imports only.
 */
import type { Store, ToornamentAutoResult, TournamentEvent } from './types.ts';
import { applyCommand, dayVersion, type Command } from './commands.ts';
import { storeDate } from './recce.ts';
import { HH_MM, planImport, underWay, type ImportPlan, type StageBracket, type ToornamentFetch } from './toornament.ts';

/** The zone the event day and the start time are read in (server: EVENT_TZ). */
export const EVENT_TZ = 'Asia/Kolkata';
/** When checking starts on a store's day, unless the campaign says otherwise. */
export const AUTO_FROM = '12:30';
export const AUTO_EVERY_MIN = 5;
/** The principal and name the server's own writes carry. */
export const AUTO_ACTOR = { principal: 'system:toornament', name: 'Toornament auto-check', role: 'super' } as const;

/* ---------- time ---------- */

/** The calendar date (yyyy-mm-dd) and clock (HH:MM, 24-hour) of `at` in a time zone. */
export function inZone(at: Date, tz: string = EVENT_TZ): { date: string; hm: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '00';
  const hh = p('hour') === '24' ? '00' : p('hour');
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hm: `${hh}:${p('minute')}`, minutes: Number(hh) * 60 + Number(p('minute')) };
}

const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** The campaign's start time for the check ('HH:MM'). */
export const autoFrom = (event: Pick<TournamentEvent, 'toornamentAuto'>) => (event.toornamentAuto && HH_MM.test(event.toornamentAuto.from) ? event.toornamentAuto.from : AUTO_FROM);

/** A store with a Toornament link is checked unless HQ switched it off. */
export const autoOn = (store: Store) => !!store.toornament?.url && store.toornament.auto?.enabled !== false;

/**
 * Where a store is in its day, for the auto-check: off (no link / switched off), future (its day
 * hasn't come), past (it has gone), before (today, earlier than the start time), open (today, from
 * the start time until midnight — checking, unless it already succeeded or stopped).
 */
export function autoWindow(store: Store, event: TournamentEvent, at: Date, tz: string = EVENT_TZ): 'off' | 'future' | 'past' | 'before' | 'open' {
  if (!autoOn(store)) return 'off';
  const day = storeDate(store, event);
  const now = inZone(at, tz);
  if (day > now.date) return 'future';
  if (day < now.date) return 'past';
  return now.minutes >= minutesOf(autoFrom(event)) ? 'open' : 'before';
}

const ENDS_THE_DAY: ToornamentAutoResult[] = ['applied', 'skipped-underway', 'skipped-manual'];

/** Today's checking is over: the bracket was loaded, or there was nothing it may replace. HQ's "Check again" clears it. */
export function autoFinished(store: Store, at: Date, tz: string = EVENT_TZ): boolean {
  const a = store.toornament?.auto;
  return !!a?.lastResult && ENDS_THE_DAY.includes(a.lastResult) && !!a.lastCheckAt && inZone(new Date(a.lastCheckAt), tz).date === inZone(at, tz).date;
}

/** Time allowed for timer jitter when deciding a store's 5 minutes are up. */
const SLACK_MS = 5000;

/** Is it time to look at this store's Toornament stage? */
export function autoDue(store: Store, event: TournamentEvent, at: Date, tz: string = EVENT_TZ, everyMs = AUTO_EVERY_MIN * 60000): boolean {
  if (autoWindow(store, event, at, tz) !== 'open' || autoFinished(store, at, tz)) return false;
  const last = store.toornament?.auto?.lastCheckAt;
  return !last || at.getTime() - Date.parse(last) >= everyMs - SLACK_MS;
}

/* ---------- what is on Toornament ---------- */

export type Readiness = { ok: true; bracket: StageBracket } | { ok: false; result: 'waiting' | 'not-placed' | 'error'; message: string };

const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).slice(0, 300);

/**
 * Is "the bracket" there? A single-elimination stage with its players placed in it — Toornament's own
 * first round, not the seeded-list fallback. Anything else says what is still missing (waiting = no
 * bracket generated; not-placed = a bracket without its players; error = a stage that can't be used).
 */
export function bracketReady(data: ToornamentFetch): Readiness {
  const { stage, bracket } = data;
  if (!stage) return { ok: false, result: 'waiting', message: 'No stage on Toornament yet.' };
  if (!stage.supported) return { ok: false, result: 'error', message: `The stage “${stage.name}” is ${stage.typeLabel.toLowerCase()} — only single elimination can be used. Put a single-elimination stage’s link on the store.` };
  if (!bracket) return { ok: false, result: 'waiting', message: 'No bracket on Toornament yet.' };
  if (bracket.mode === 'pairs' && bracket.pairs && bracket.players.length >= 2) return { ok: true, bracket };
  if (bracket.why === 'not-generated') return { ok: false, result: 'waiting', message: 'No bracket on Toornament yet.' };
  if (bracket.why === 'unplaced') return { ok: false, result: 'not-placed', message: 'The bracket is on Toornament, but the players aren’t placed in it yet.' };
  return { ok: false, result: 'not-placed', message: firstSentence(bracket.problem ?? 'The bracket on Toornament can’t be used yet.') };
}

/* ---------- the store's own bracket ---------- */

/**
 * Where the store's current bracket came from: none (no matches), toornament (built by a
 * bracket.load whose id the store remembers — HQ's "Use this bracket" or this check), or manual
 * (anything else: built by hand, or the id was lost).
 */
export function bracketOrigin(store: Store): 'none' | 'toornament' | 'manual' {
  const matches = store.day.matches;
  if (!matches.length) return 'none';
  const id = store.toornament?.loadId;
  return id && matches.every((m) => m.id.startsWith(`${id}-`)) ? 'toornament' : 'manual';
}

/** Why the check must leave this store's bracket alone, or null when it may replace it. */
export function mayNotReplace(store: Store): { result: 'skipped-underway' | 'skipped-manual'; message: string } | null {
  if (underWay(store)) return { result: 'skipped-underway', message: 'Matches are already under way, so the bracket was left alone.' };
  if (bracketOrigin(store) === 'manual') return { result: 'skipped-manual', message: 'A bracket built here by hand is in place, so it was left alone.' };
  return null;
}

/** HQ loaded this store's bracket from Toornament today and it hasn't been touched since — the check has nothing left to do. */
export function loadedByHq(store: Store, at: Date, tz: string = EVENT_TZ): boolean {
  const t = store.toornament;
  return !!t?.appliedAt && !!t.by && t.by !== AUTO_ACTOR.principal && bracketOrigin(store) === 'toornament' && inZone(new Date(t.appliedAt), tz).date === inZone(at, tz).date;
}

/** Would the server take this bracket.load? Used to keep walk-ins on the list outside Toornament's pairings, where that's accepted. */
function loadTakes(store: Store, event: TournamentEvent, plan: ImportPlan) {
  try {
    applyCommand(store, loadCommand(store, plan), { commandId: 'hq-probe', now: new Date().toISOString(), actor: { principal: 'super', name: 'HQ', role: 'super' }, event });
    return true;
  } catch {
    return false;
  }
}

/**
 * Toornament's bracket against this store's players, as HQ's "Use this bracket" shows it: matched
 * players keep their phone, in-game name and check-in; walk-ins Toornament doesn't have stay on the
 * list outside the bracket, where the server accepts that.
 */
export function planFor(bracket: StageBracket, store: Store, event: TournamentEvent): ImportPlan {
  const opts = { onSpot: store.day.onSpot ?? [] };
  const plain = planImport(bracket, store.day.players, opts);
  if (!plain.pairs || !plain.onSpotMissing.some((m) => m.player)) return plain;
  const kept = planImport(bracket, store.day.players, { ...opts, keepOutside: true });
  return loadTakes(store, event, kept) ? kept : plain;
}

export const loadCommand = (store: Store, plan: ImportPlan): Extract<Command, { type: 'bracket.load' }> => ({ type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs, ...(plan.nodes.length ? { toornament: plan.nodes } : {}) });

/* ---------- HQ's line ---------- */

const hm = (iso: string, tz: string) => inZone(new Date(iso), tz).hm;
const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const LABEL: Record<ToornamentAutoResult, string> = {
  waiting: 'no bracket on Toornament yet',
  'not-placed': 'the players aren’t placed in the bracket yet',
  applied: 'the bracket was loaded',
  'skipped-underway': 'matches are under way, so the bracket was left alone',
  'skipped-manual': 'a bracket built by hand is in place, so it was left alone',
  error: 'couldn’t read Toornament',
};

/**
 * The status line on the store's bracket step. `tone`: ok = done, warn = needs HQ, muted = just waiting or off.
 * Times are India time (the zone the server checks in).
 */
export function autoLine(store: Store, event: TournamentEvent, at: Date = new Date(), tz: string = EVENT_TZ): { text: string; tone: 'ok' | 'warn' | 'muted'; on: boolean } {
  const a = store.toornament?.auto;
  const day = storeDate(store, event);
  if (!store.toornament?.url) return { text: 'Auto-check: add the Toornament link to turn it on', tone: 'muted', on: false };
  if (a?.enabled === false) return { text: 'Auto-check: off — the bracket is fetched by hand', tone: 'muted', on: false };
  const stamp = (iso: string) => `${hm(iso, tz)}${inZone(new Date(iso), tz).date === inZone(at, tz).date ? '' : ` on ${dayLabel(inZone(new Date(iso), tz).date)}`}`;
  if (a?.lastResult === 'applied' && a.appliedAt) return { text: `${store.toornament.by === AUTO_ACTOR.principal ? 'Applied automatically' : 'Loaded by HQ'} at ${stamp(a.appliedAt)} ✓${a.message ? ` — ${a.message}` : ''}`, tone: 'ok', on: true };
  const plan = `from ${autoFrom(event)} on ${dayLabel(day)}, every ${AUTO_EVERY_MIN} min`;
  if (a?.lastResult === 'skipped-underway' || a?.lastResult === 'skipped-manual') return { text: `Auto-check stopped at ${stamp(a.lastCheckAt ?? at.toISOString())}: ${a.message ?? LABEL[a.lastResult]}`, tone: 'warn', on: true };
  const last = a?.lastCheckAt && a.lastResult ? ` · last checked ${stamp(a.lastCheckAt)}: ${a.message ?? LABEL[a.lastResult]}` : '';
  const window = autoWindow(store, event, at, tz);
  if (window === 'past' && !last) return { text: `Auto-check: on — it only runs on the store’s day (${dayLabel(day)}), which has passed`, tone: 'muted', on: true };
  return { text: `Auto-check: on — ${plan}${last}`, tone: a?.lastResult === 'error' ? 'warn' : 'muted', on: true };
}
