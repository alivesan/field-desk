import type { IncomingMessage } from 'node:http';

/*
 * Sign-in rate limiting (F21).
 *
 * Client address: the socket's peer address, unless TRUST_PROXY = N (> 0) trusted reverse-proxy
 * hops sit in front — then the address N entries from the right of X-Forwarded-For, i.e. the
 * one the outermost trusted proxy saw. With the default 0, X-Forwarded-For is ignored entirely,
 * so a client can't pick its own bucket by sending the header.
 *
 * Buckets (fixed windows, failures only; a success clears that source's bucket):
 *   admin:<ip>   wrong 4-character codes from one source      default 10 / 15 min
 *   hq:<ip>      wrong HQ codes from one source               default 10 / 15 min
 *   admin:*      wrong 4-character codes from everyone        default 300 / hour
 * The global ceiling exists because 4-character codes are guessable by a distributed attacker;
 * it only ever blocks admin-code sign-ins, never HQ's, which has its own per-source bucket.
 */

export function clientIp(req: IncomingMessage, trustProxy: number): string {
  const peer = req.socket.remoteAddress ?? '?';
  if (!trustProxy) return peer;
  const raw = req.headers['x-forwarded-for'];
  const list = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return peer;
  return list[Math.max(0, list.length - trustProxy)];
}

export interface LimitConfig {
  perSource: number;
  perSourceWindowMs: number;
  adminGlobal: number;
  adminGlobalWindowMs: number;
}

export const DEFAULT_LIMITS: LimitConfig = { perSource: 10, perSourceWindowMs: 15 * 60000, adminGlobal: 300, adminGlobalWindowMs: 3600000 };

export type LoginKind = 'admin' | 'hq';

export function createLoginLimiter(cfg: LimitConfig, now: () => number) {
  const buckets = new Map<string, { n: number; until: number }>();
  const over = (key: string, max: number) => {
    const b = buckets.get(key);
    return b && b.until > now() && b.n >= max ? b.until - now() : 0;
  };
  const bump = (key: string, windowMs: number) => {
    const b = buckets.get(key);
    buckets.set(key, b && b.until > now() ? { n: b.n + 1, until: b.until } : { n: 1, until: now() + windowMs });
  };
  const sweep = () => {
    if (buckets.size < 10000) return;
    for (const [k, b] of buckets) if (b.until <= now()) buckets.delete(k);
  };
  return {
    /** Milliseconds until this source may try again; 0 = go ahead. */
    blockedFor(ip: string, kind: LoginKind) {
      return Math.max(over(`${kind}:${ip}`, cfg.perSource), kind === 'admin' ? over('admin:*', cfg.adminGlobal) : 0);
    },
    fail(ip: string, kind: LoginKind) {
      sweep();
      bump(`${kind}:${ip}`, cfg.perSourceWindowMs);
      if (kind === 'admin') bump('admin:*', cfg.adminGlobalWindowMs);
    },
    succeed(ip: string, kind: LoginKind) {
      buckets.delete(`${kind}:${ip}`);
    },
  };
}
