/*
 * HQ's Steam accounts and who has which for a weekend. Pure and Node-loadable (the server imports it
 * to work out what a store team may see).
 *
 * A store is given one account (Store.steam) for its event weekend, for one of two purposes:
 *   play      — only one PC can be online with an account at a time, so a play account is exclusive:
 *               two stores whose event dates fall in the same weekend can't both play with it;
 *   download  — many PCs can download at once, so any number of stores (and a recce) may share it.
 * A "weekend" is the Saturday of the Monday–Sunday week the store's date falls in (weekends.ts) — an
 * event on a weekday is bucketed with the rest of its own week.
 */
import type { AppState, SteamAccount, SteamLogin, SteamOtp, SteamPurpose, Store, StoreOtpState } from './types.ts';
import { storeDate } from './recce.ts';
import { weekendOf, weekendLabel } from './weekends.ts';
import { addDaysLocal } from './util.ts';

export const STEAM_PURPOSES: SteamPurpose[] = ['play', 'download'];
export const MAX_STEAM_TEXT = 200;

type World = Pick<AppState, 'events' | 'stores'>;

/** The weekend bucket of a date: that week's Saturday, yyyy-mm-dd. */
export const weekKeyOf = (date: string) => weekendOf(date).sat;

/** The weekend a store plays in (its Saturday), or null when its campaign is gone. */
export function storeWeekend(world: World, store: Store): string | null {
  const event = world.events[store.eventId];
  const date = event ? storeDate(store, event) : store.date;
  return date ? weekKeyOf(date) : null;
}

/** "Sat 31 Oct – Sun 1 Nov" for a weekend key. */
export const weekendKeyLabel = (sat: string) => weekendLabel(weekendOf(sat));

export const purposeLabel = (p: SteamPurpose) => (p === 'play' ? 'Play' : 'Downloads');

/**
 * Stores that already hold this account for playing in the same weekend as `storeId` — the reason it
 * can't be given to this store for playing. Downloads never clash, and neither does a store with itself.
 */
export function steamConflicts(world: World, storeId: string, accountId: string, purpose: SteamPurpose): Store[] {
  if (purpose !== 'play') return [];
  const me = world.stores[storeId];
  if (!me) return [];
  const week = storeWeekend(world, me);
  if (!week) return [];
  return Object.values(world.stores)
    .filter((s) => s.id !== storeId && s.steam?.accountId === accountId && s.steam.purpose === 'play' && storeWeekend(world, s) === week)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the account is assigned to, nearest event first. */
export interface SteamUse {
  store: Store;
  purpose: SteamPurpose;
  date: string; // the store's event day
  week: string; // its weekend (Saturday)
}

export function steamUses(world: World, accountId: string): SteamUse[] {
  const out: SteamUse[] = [];
  for (const store of Object.values(world.stores)) {
    if (store.steam?.accountId !== accountId) continue;
    const event = world.events[store.eventId];
    const date = event ? storeDate(store, event) : store.date || '';
    out.push({ store, purpose: store.steam.purpose, date, week: date ? weekKeyOf(date) : '' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.store.name.localeCompare(b.store.name));
}

/** How an account looks for one store's weekend, for the picker. */
export interface SteamAvailability {
  /** This store already has it. */
  mine: boolean;
  /** Stores playing with it this weekend (not counting this one). */
  playingAt: Store[];
  /** Stores using it for downloads this weekend (not counting this one). */
  downloadingAt: Store[];
  /** Free to give this store for playing. */
  canPlay: boolean;
}

export function steamAvailability(world: World, store: Store, accountId: string): SteamAvailability {
  const week = storeWeekend(world, store);
  const others = steamUses(world, accountId).filter((u) => u.store.id !== store.id && week !== null && u.week === week);
  const playingAt = others.filter((u) => u.purpose === 'play').map((u) => u.store);
  return {
    mine: store.steam?.accountId === accountId,
    playingAt,
    downloadingAt: others.filter((u) => u.purpose === 'download').map((u) => u.store),
    canPlay: playingAt.length === 0,
  };
}

/** The accounts, label first (else username), for lists. */
export const steamAccountName = (a: Pick<SteamAccount, 'label' | 'username'>) => (a.label?.trim() ? `${a.label.trim()} · ${a.username}` : a.username);

export function sortedAccounts(accounts: Record<string, SteamAccount>): SteamAccount[] {
  const key = (a: SteamAccount) => (a.label?.trim() || a.username).toLowerCase();
  return Object.values(accounts).sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
}

export type WeekFilter = 'this' | 'next' | 'all';

/** The Saturday a filter means (null = every weekend). `today` is yyyy-mm-dd on the device. */
export function weekFilterKey(filter: WeekFilter, today: string): string | null {
  if (filter === 'all') return null;
  const sat = weekKeyOf(today);
  return filter === 'this' ? sat : addDaysLocal(sat, 7);
}

/** Whether the account has a play assignment in the weekend (`week` null = ever). */
export function inUse(world: World, accountId: string, week: string | null): boolean {
  return steamUses(world, accountId).some((u) => u.purpose === 'play' && (week === null || u.week === week));
}

/** How long a Steam Guard code lives, counted from when Steam sent the e-mail. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** Stores holding the account, for any purpose, whose event day hasn't passed (`today` is yyyy-mm-dd). */
export function steamHolders(world: World, accountId: string, today: string): Store[] {
  return steamUses(world, accountId)
    .filter((u) => u.date && u.date >= today)
    .map((u) => u.store);
}

/**
 * The store the account is working for right now, or null when that can't be said:
 *  - the one store playing with it this weekend; else
 *  - the only store holding it at all (any purpose) whose event day hasn't passed; else null (nobody, or more than one).
 */
export function currentSteamStore(world: World, accountId: string, today: string): Store | null {
  const week = weekKeyOf(today);
  const playing = steamUses(world, accountId).filter((u) => u.purpose === 'play' && u.week === week);
  if (playing.length) return playing.length === 1 ? playing[0].store : null;
  const holders = steamHolders(world, accountId, today);
  return holders.length === 1 ? holders[0] : null;
}

/** The account's Steam Guard code if it hasn't expired at `nowMs`. */
export function liveOtp(account: Pick<SteamAccount, 'otp'> | undefined, nowMs: number): SteamOtp | undefined {
  const o = account?.otp;
  return o && Date.parse(o.expiresAt) > nowMs ? { code: o.code, receivedAt: o.receivedAt, expiresAt: o.expiresAt } : undefined;
}

export const LOOKUP_GRACE_MS = 60 * 1000; // a lookup also takes an email sent up to a minute before it
export const LOOKUP_WINDOW_MS = 10 * 60 * 1000; // and watches for ten minutes

/**
 * The code a store's card may show now, given its lookup state — see docs/steam-otp-api.md. An unexpired code, unless the
 * team has moved past it (`seenThrough`); after a lookup only a code sent no earlier than a minute before it (however
 * late); after "Logged in" nothing until the next lookup; with no state at all, the code.
 */
export function cardOtp(account: Pick<SteamAccount, 'otp'> | undefined, state: StoreOtpState | undefined, nowMs: number): SteamOtp | undefined {
  const otp = liveOtp(account, nowMs);
  if (!otp) return undefined;
  const at = Date.parse(otp.receivedAt);
  if (state?.seenThrough && at <= Date.parse(state.seenThrough)) return undefined;
  if (state?.lookup) return at >= Date.parse(state.lookup.requestedAt) - LOOKUP_GRACE_MS ? otp : undefined;
  return state?.dismissedAt ? undefined : otp;
}

/** Whatever else the server knows about a store's login at read time (see steamLoginFor). */
export interface SteamLoginExtras {
  otp?: SteamOtp;
  otpRequest?: boolean;
  otpLookup?: { id: string; requestedAt: string };
  otpRequestedAt?: string;
}

/**
 * What a store's team may see of its Steam account: the login, never the account's id or notes.
 * Computed by the server on every read (visibleDocs) — never stored. `extras` is what the server worked out
 * for this moment: the Steam Guard code the card may show, whether the Get code button works, and the team's last lookup.
 */
export function steamLoginFor(store: Pick<Store, 'steam'>, accounts: Record<string, SteamAccount> | undefined, extras: SteamLoginExtras = {}): SteamLogin | undefined {
  const a = store.steam && accounts?.[store.steam.accountId];
  if (!store.steam || !a) return undefined;
  // The account's email stays with HQ: the store team gets the Steam Guard code from the OTP automation, or by calling HQ.
  return {
    username: a.username,
    password: a.password,
    purpose: store.steam.purpose,
    ...(extras.otp ? { otp: extras.otp } : {}),
    ...(extras.otpRequest ? { otpRequest: true } : {}),
    ...(extras.otpLookup ? { otpLookup: extras.otpLookup } : {}),
    ...(extras.otpRequestedAt ? { otpRequestedAt: extras.otpRequestedAt } : {}),
  };
}

/** "this weekend" when the weekend is the current one, else "the weekend of Sat 31 Oct – Sun 1 Nov". */
export const weekendPhrase = (sat: string, today: string) => (sat === weekKeyOf(today) ? 'this weekend' : `the weekend of ${weekendKeyLabel(sat)}`);

/** What a clash is explained with: "Already playing at Incredible Technologies this weekend — …". */
export function conflictMessage(clashes: Store[], shortName: (name: string) => string, when: string): string {
  return `Already playing at ${clashes.map((s) => shortName(s.name)).join(', ')} ${when} — assign it for downloads only, or pick another account.`;
}
