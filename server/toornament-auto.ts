import { createHash } from 'node:crypto';
import type { Command } from '../src/lib/commands.ts';
import type { Store, ToornamentSource, ToornamentAutoResult, TournamentEvent } from '../src/lib/types.ts';
import { AUTO_ACTOR, AUTO_EVERY_MIN, autoDue, autoOn, bracketReady, EVENT_TZ, loadCommand, loadedByHq, mayNotReplace, planFor } from '../src/lib/toornament-auto.ts';
import { consoleLogger, errorFields, type Logger } from './log.ts';
import { RosterFetchError, type RosterFetchOptions } from './roster-fetch.ts';
import { fetchToornament } from './toornament-fetch.ts';

/*
 * The Toornament auto-check. Walk-ins register until about 12:30–1 pm on the event day, HQ then adds
 * them on toornament.com and Toornament publishes the bracket. From 12:30 India time (the campaign can
 * change it) the server looks at each store's Toornament stage every 5 minutes, and once the players
 * are placed in a single-elimination bracket it loads it — the same bracket.load HQ's "Use this
 * bracket" sends — and stops for that store. It runs here, not in HQ's browser, so it works with
 * nobody signed in.
 *
 * Rules (the pure parts are in src/lib/toornament-auto.ts):
 *   - Only stores with a Toornament link, switched on (store.toornament.auto.enabled, default on),
 *     on their own day (storeDate, in EVENT_TZ), from the start time until midnight.
 *   - Never replaces a bracket that is under way, nor one that was built by hand (only an empty
 *     bracket, or one an earlier Toornament load built that hasn't started). Those end the day's
 *     checking for the store, as does a successful load; HQ's "Check again" clears it.
 *   - One store at a time, a pause between stores, and a longer pause for everyone after a 429.
 *   - Each check is recorded on the store (store.toornament.auto) through the normal commit path,
 *     so HQ's screens update by themselves; the load and its record are one commit.
 *
 * Needs the server to hand it the store documents and a way to commit (see createApi); tests drive
 * tick() with a fake clock and an injected fetch.
 */

export interface AutoHost {
  stores(): Store[];
  store(id: string): Store | undefined;
  event(id: string): TournamentEvent | undefined;
  /** bracket.load as the system actor, with `edit` applied to the store's Toornament record in the same commit. Throws if the server refuses it. */
  apply(storeId: string, commandId: string, cmd: Extract<Command, { type: 'bracket.load' }>, edit: (t: ToornamentSource) => void): void;
  /** Edits the store's Toornament record (one commit; nothing if the store or its link has gone). */
  record(storeId: string, edit: (t: ToornamentSource) => void): void;
}

export interface ToornamentAutoOptions {
  /** Run the timer. Off unless asked (server/index.ts asks; tests that want it ask). */
  enabled?: boolean;
  /** The clock. Default: the server's. */
  now?: () => Date;
  /** How often each store is checked. Default 5 minutes. */
  intervalMs?: number;
  /** How often the timer looks for stores that are due. Default 30 s. */
  tickMs?: number;
  /** Pause between two stores' fetches. Default 1 s. */
  gapMs?: number;
  /** The time zone of the event day (EVENT_TZ). Default Asia/Kolkata. */
  tz?: string;
  /** Test double for the Toornament fetch. */
  fetch?: typeof fetchToornament;
}

const MAX_PAUSE_MS = 30 * 60000;

const zoneOk = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createToornamentAuto(host: AutoHost, opts: ToornamentAutoOptions & { rosterFetch?: RosterFetchOptions; log?: Logger } = {}) {
  const log = opts.log ?? consoleLogger;
  const now = opts.now ?? (() => new Date());
  const intervalMs = opts.intervalMs ?? AUTO_EVERY_MIN * 60000;
  const tickMs = opts.tickMs ?? 30000;
  const gapMs = opts.gapMs ?? 1000;
  const fetchIt = opts.fetch ?? fetchToornament;
  let tz = opts.tz ?? process.env.EVENT_TZ?.trim() ?? EVENT_TZ;
  if (!zoneOk(tz)) {
    log('warn', 'toornament-auto', { message: 'EVENT_TZ is not a time zone — using ' + EVENT_TZ });
    tz = EVENT_TZ;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let running = false;
  let pausedUntil = 0; // after a 429: nobody is fetched until then
  let backoff = 0;

  /** Records one check on the store. `extra` runs in the same commit. */
  function finish(store: Store, at: Date, result: ToornamentAutoResult, message: string, extra?: (t: ToornamentSource) => void) {
    host.record(store.id, (t) => {
      t.auto = { enabled: t.auto?.enabled !== false, lastCheckAt: at.toISOString(), lastResult: result, message };
      extra?.(t);
    });
    log('info', 'toornament-auto', { store: store.id, result });
  }

  async function check(id: string, at: Date) {
    let store = host.store(id);
    const event = store && host.event(store.eventId);
    if (!store?.toornament || !event) return;
    const stop = mayNotReplace(store);
    if (stop) return finish(store, at, stop.result, stop.message);
    // HQ pressed "Use this bracket" today and nothing has been touched since: the data is in, so stop.
    if (loadedByHq(store, at, tz)) return finish(store, at, 'applied', 'HQ already loaded the bracket from Toornament today.', (t) => void (t.auto!.appliedAt = t.appliedAt));

    let data;
    try {
      data = await fetchIt(store.toornament.url, store.toornament.stageId, opts.rosterFetch ?? {});
      backoff = 0;
    } catch (e) {
      const status = e instanceof RosterFetchError ? e.extra?.status : undefined;
      if (status === 429 || status === 503) {
        pausedUntil = now().getTime() + Math.min(intervalMs * 2 ** ++backoff, MAX_PAUSE_MS);
        return finish(store, at, 'error', 'Toornament asked us to slow down — trying again in a few minutes.');
      }
      if (!(e instanceof RosterFetchError)) log('error', 'toornament-auto-failed', { store: id, ...errorFields(e) });
      return finish(store, at, 'error', e instanceof RosterFetchError ? e.message.slice(0, 300) : 'Couldn’t check Toornament — trying again.');
    }

    // The fetch took a while: look at the store as it is now.
    store = host.store(id);
    if (!store?.toornament || !autoOn(store)) return;
    const stopNow = mayNotReplace(store);
    if (stopNow) return finish(store, at, stopNow.result, stopNow.message);
    const ready = bracketReady(data);
    if (!ready.ok) return finish(store, at, ready.result, ready.message);

    const plan = planFor(ready.bracket, store, event);
    if (!plan.pairs || plan.players.length < 2) return finish(store, at, 'not-placed', 'Toornament’s first round can’t be used yet.');
    const cmd = loadCommand(store, plan);
    const commandId = `ta-${createHash('sha256').update(`${store.id}:${cmd.base}`).digest('hex').slice(0, 24)}`; // same store and bracket version → same command: it can't apply twice
    const kept = plan.onSpotMissing.filter((m) => m.kept).length;
    const message = [
      `${plan.players.length - kept} players placed from Toornament.`,
      kept ? `${kept} walk-in${kept === 1 ? '' : 's'} not on Toornament yet ${kept === 1 ? 'stays' : 'stay'} on the list, outside the bracket.` : '',
      plan.dropped.length ? `${plan.dropped.length} on the list but not on Toornament ${plan.dropped.length === 1 ? 'was' : 'were'} removed.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const stage = data.stage!;
    try {
      host.apply(store.id, commandId, cmd, (t) => {
        t.loadId = commandId;
        t.stageId = stage.id;
        t.stageName = stage.name;
        t.tournamentName = data.tournament.name.slice(0, 200);
        t.appliedAt = at.toISOString();
        t.by = AUTO_ACTOR.principal;
        t.auto = { enabled: t.auto?.enabled !== false, lastCheckAt: at.toISOString(), lastResult: 'applied', message, appliedAt: at.toISOString() };
      });
    } catch (e) {
      return finish(store, at, 'error', `Toornament’s bracket couldn’t be loaded: ${(e instanceof Error ? e.message : String(e)).slice(0, 250)}`);
    }
    log('info', 'toornament-auto', { store: store.id, result: 'applied', players: plan.players.length, matches: plan.pairs.length });
  }

  /** One pass: every store that is due, one after the other. Resolves when done; never throws. */
  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const at = now();
      if (pausedUntil > at.getTime()) return;
      const due = host
        .stores()
        .filter((s) => {
          const event = host.event(s.eventId);
          return !!event && autoDue(s, event, at, tz, intervalMs);
        })
        .map((s) => s.id);
      for (let i = 0; i < due.length && !stopped; i++) {
        if (i && gapMs) await sleep(gapMs);
        if (pausedUntil > now().getTime()) break;
        try {
          await check(due[i], at);
        } catch (e) {
          log('error', 'toornament-auto-failed', { store: due[i], ...errorFields(e) });
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), tickMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    /** Next time anything may be fetched, after a 429 (ms since epoch; 0 = not paused). For tests and logs. */
    get pausedUntil() {
      return pausedUntil;
    },
  };
}
