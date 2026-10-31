import type { Store } from '../src/lib/types.ts';
import { BRACKET_TOKEN, CHECKIN_TOKEN } from '../src/lib/schema.ts';
import { isPhone, normalizePhone, publicName } from '../src/lib/phone.ts';

/*
 * Player self check-in (no sign-in): the venue QR opens /c/<token>, the player types their phone
 * number and is checked in. The routes live in server/api.ts; this is the lookup and its limits.
 *
 * Anyone at the venue can photograph the QR, so the token is not a secret from the public — it
 * only names a store. What must not leak is who is registered: the GET says nothing about
 * players, and a POST only answers for a number someone already knows (and then just
 * "First L."). Guessing numbers is throttled:
 *
 *   ip:<addr>      per client address (see clientIp: X-Forwarded-For only with TRUST_PROXY)
 *                  default 60 points / 10 min. A check-in costs 1, a failed one (no match,
 *                  ambiguous, not a phone, unknown token) costs 4 — so ~15 wrong numbers per
 *                  address per 10 min, while a venue Wi-Fi with many players behind one NAT
 *                  still fits ~60 real check-ins.
 *   store:<id>     per store, whatever the address: default 300 attempts / 10 min (every POST
 *                  costs 1). Caps a distributed guesser; if it trips, the desk checks players in.
 * Fixed windows; a blocked caller gets 429 + Retry-After. Nothing here logs a token or a number.
 */

export interface PublicLimitConfig {
  perIp: number;
  perIpWindowMs: number;
  perStore: number;
  perStoreWindowMs: number;
  /** What a failed lookup costs against the per-address budget (a success costs 1). */
  failCost: number;
}

export const DEFAULT_PUBLIC_LIMITS: PublicLimitConfig = { perIp: 60, perIpWindowMs: 10 * 60000, perStore: 300, perStoreWindowMs: 10 * 60000, failCost: 4 };

export function createPublicLimiter(cfg: PublicLimitConfig, now: () => number) {
  const buckets = new Map<string, { n: number; until: number }>();
  const over = (key: string, max: number) => {
    const b = buckets.get(key);
    return b && b.until > now() && b.n >= max ? b.until - now() : 0;
  };
  const spend = (key: string, cost: number, windowMs: number) => {
    if (buckets.size >= 10000) for (const [k, b] of buckets) if (b.until <= now()) buckets.delete(k);
    const b = buckets.get(key);
    buckets.set(key, b && b.until > now() ? { n: b.n + cost, until: b.until } : { n: cost, until: now() + windowMs });
  };
  return {
    /** Milliseconds until this address may try again; 0 = go ahead. */
    ipBlockedFor: (ip: string) => over(`ip:${ip}`, cfg.perIp),
    storeBlockedFor: (storeId: string) => over(`store:${storeId}`, cfg.perStore),
    /** Records one attempt: `failed` ones cost more against the address. */
    attempt(ip: string, storeId: string | null, failed: boolean) {
      spend(`ip:${ip}`, failed ? cfg.failCost : 1, cfg.perIpWindowMs);
      if (storeId) spend(`store:${storeId}`, 1, cfg.perStoreWindowMs);
    },
  };
}

/** The store whose current QR carries this token, or undefined (bad format, unknown, rotated). */
export function storeByToken(stores: Record<string, Store>, token: string): Store | undefined {
  if (!CHECKIN_TOKEN.test(token)) return undefined;
  return Object.values(stores).find((s) => s.day?.selfCheckIn?.token === token);
}

/** The store whose public bracket link carries this token and is switched on, or undefined (bad format, unknown, rotated, off). */
export function storeByBracketToken(stores: Record<string, Store>, token: string): Store | undefined {
  if (!BRACKET_TOKEN.test(token)) return undefined;
  return Object.values(stores).find((s) => s.publicBracket?.on === true && s.publicBracket.token === token);
}

export type SelfCheckInResult =
  | { kind: 'closed' }
  | { kind: 'bad-phone' }
  | { kind: 'no-match' }
  | { kind: 'ambiguous' }
  | { kind: 'already'; name: string }
  | { kind: 'ok'; name: string; next: Store };

/** Pure: what a self check-in with `phone` does to `store` at server time `at`. Never mutates `store`. */
export function selfCheckIn(store: Store, phone: unknown, at: string): SelfCheckInResult {
  if (store.day?.selfCheckIn?.open !== true) return { kind: 'closed' };
  if (typeof phone !== 'string' || phone.length > 40 || !isPhone(phone)) return { kind: 'bad-phone' };
  const n = normalizePhone(phone);
  const found = (store.day.players ?? []).filter((p) => p.phone === n);
  if (!found.length) return { kind: 'no-match' };
  if (found.length > 1) return { kind: 'ambiguous' };
  const p = found[0];
  const name = publicName(p.name);
  if (store.day.checkIn?.[p.id]) return { kind: 'already', name };
  const next = structuredClone(store);
  next.day.checkIn = { ...next.day.checkIn, [p.id]: at };
  next.day.checkInSource = { ...next.day.checkInSource, [p.id]: 'self' };
  next.updatedAt = at;
  return { kind: 'ok', name, next };
}
