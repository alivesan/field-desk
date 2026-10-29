import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from './log.ts';

/*
 * The server's side of the Steam Guard (OTP) automation — see docs/steam-otp-api.md.
 *
 *   FD_STEAM_API_KEY          bearer token of the automation: the ONLY credential /api/v1/steam/* accepts
 *                             (and accepted nowhere else). Unset = those routes answer 503 not_configured.
 *   FD_STEAM_WEBHOOK_URL      where a store's "Request code" is sent (steam.otp.requested), signed with
 *   FD_STEAM_WEBHOOK_SECRET   HMAC-SHA256 over the exact bytes sent. Both unset = the feature is off.
 *
 * Nothing in here logs a request body, a code, a header or the webhook address.
 */

export interface SteamOtpOptions {
  /** Bearer token of the automation (FD_STEAM_API_KEY). */
  apiKey?: string;
  /** Request webhook (FD_STEAM_WEBHOOK_URL / FD_STEAM_WEBHOOK_SECRET). */
  webhookUrl?: string;
  webhookSecret?: string;
  /** Pauses between delivery attempts, the last one repeating. Default 5 s, 15 s, 45 s, 90 s. */
  retryDelaysMs?: number[];
  /** One delivery attempt gives up after this long. Default 5 s. */
  attemptTimeoutMs?: number;
  /** One request per store per this long. Default 60 s. */
  requestEveryMs?: number;
}

export interface SteamOtpConfig {
  apiKey: string | null;
  webhook: { url: string; secret: string } | null;
}

/** Options first, then the environment; blank counts as unset. A half-configured webhook is off. */
export function steamOtpConfig(opts: SteamOtpOptions, log: Logger, env: NodeJS.ProcessEnv = process.env): SteamOtpConfig {
  const pick = (given: string | undefined, name: string) => (given !== undefined ? given : env[name])?.trim() || '';
  const apiKey = pick(opts.apiKey, 'FD_STEAM_API_KEY');
  const url = pick(opts.webhookUrl, 'FD_STEAM_WEBHOOK_URL');
  const secret = pick(opts.webhookSecret, 'FD_STEAM_WEBHOOK_SECRET');
  let webhook: SteamOtpConfig['webhook'] = null;
  if (url || secret) {
    let valid = false;
    try {
      valid = ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      /* not a URL */
    }
    if (url && secret && valid) webhook = { url, secret };
    else log('warn', 'steam-otp-webhook-off', { message: 'FD_STEAM_WEBHOOK_URL (an http/https address) and FD_STEAM_WEBHOOK_SECRET must both be set — the request webhook is off.' });
  }
  return { apiKey: apiKey || null, webhook };
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();

/** `Authorization: Bearer <key>` against the configured key, in constant time (both sides hashed to equal length). */
export function bearerMatches(header: string | undefined, key: string): boolean {
  const m = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header) : null;
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]), sha256(key));
}

/* ---------- idempotency keys (server-only table, survives restarts) ---------- */

/** Keys are kept this long (the contract asks for at least 24 hours). */
export const KEY_RETENTION_MS = 48 * 3600 * 1000;

export interface KeyRow {
  fingerprint: string;
  result: Record<string, unknown>;
}

export function createKeyStore(db: DatabaseSync, now: () => number) {
  db.exec(`CREATE TABLE IF NOT EXISTS steam_otp_keys (
    key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS steam_otp_keys_at ON steam_otp_keys (created_at);`);
  const find = db.prepare('SELECT fingerprint, result FROM steam_otp_keys WHERE key = ? AND created_at > ?');
  const add = db.prepare('INSERT OR IGNORE INTO steam_otp_keys (key, fingerprint, result, created_at) VALUES (?, ?, ?, ?)');
  const drop = db.prepare('DELETE FROM steam_otp_keys WHERE created_at <= ?');
  return {
    /** Only the fingerprint (a hash — never the code itself) and the result we answered with are kept. */
    get(key: string): KeyRow | undefined {
      const row = find.get(key, now() - KEY_RETENTION_MS) as { fingerprint: string; result: string } | undefined;
      return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : undefined;
    },
    put(key: string, fingerprint: string, result: Record<string, unknown>) {
      add.run(key, fingerprint, JSON.stringify(result), now());
    },
    prune() {
      drop.run(now() - KEY_RETENTION_MS);
    },
  };
}

/** username + code + receivedAt (ms), hashed — what "the same request" means for an Idempotency-Key. */
export const otpFingerprint = (username: string, code: string, receivedMs: number) => sha256(`${username}\0${code}\0${receivedMs}`).toString('hex');

/* ---------- the request webhook ---------- */

export interface OtpRequestPayload {
  id: string;
  type: 'steam.otp.requested';
  at: string;
  storeId: string;
  storeName: string;
  accountUsername: string;
  accountEmail?: string;
}

export type Delivery = 'pending' | 'delivered' | 'failed';

export interface OtpRequestState {
  id: string;
  at: string;
  delivery: Delivery;
  /** True when this call found a request made in the last minute instead of making a new one. */
  duplicate: boolean;
}

interface Pending {
  payload: OtpRequestPayload;
  atMs: number;
  delivery: Delivery;
}

/** A request is a hint for the automation to look for the e-mail; it is answered for this long (the code's own life). */
export const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_DELAYS = [5000, 15000, 45000, 90000];

/**
 * Remembers the last request of each store (in memory only — it is a polling hint, so one lost in a restart
 * costs the team a second press) and delivers it, signed, to the webhook: 2xx done; a timeout, a network
 * error or a 5xx is tried again later with the same id and the very same bytes until 10 minutes after `at`;
 * any other answer ends it.
 */
export function createOtpRequests(cfg: SteamOtpConfig['webhook'], o: SteamOtpOptions, now: () => number, log: Logger) {
  const delays = o.retryDelaysMs?.length ? o.retryDelaysMs : DEFAULT_DELAYS;
  const timeoutMs = o.attemptTimeoutMs ?? 5000;
  const every = o.requestEveryMs ?? 60000;
  const byStore = new Map<string, Pending>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inflight = new Set<AbortController>();
  let closed = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      t.unref();
      timers.add(t);
    });

  /** One attempt: 'ok' (2xx), 'retry' (timeout / network / 5xx) or 'stop' (anything else). */
  async function attempt(body: Buffer, signature: string): Promise<'ok' | 'retry' | 'stop'> {
    const ctl = new AbortController();
    inflight.add(ctl);
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(cfg!.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fielddesk-signature': signature },
        body,
        redirect: 'manual',
        signal: ctl.signal,
      });
      void res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return 'ok';
      return res.status >= 500 ? 'retry' : 'stop';
    } catch {
      return 'retry';
    } finally {
      clearTimeout(timer);
      inflight.delete(ctl);
    }
  }

  async function deliver(p: Pending) {
    // The bytes are made once: every retry sends exactly these, with the signature over exactly these.
    const body = Buffer.from(JSON.stringify(p.payload), 'utf8');
    const signature = `sha256=${createHmac('sha256', cfg!.secret).update(body).digest('hex')}`;
    const deadline = p.atMs + REQUEST_WINDOW_MS;
    for (let n = 0; !closed; n++) {
      const outcome = await attempt(body, signature);
      if (closed) return;
      if (outcome === 'ok') {
        p.delivery = 'delivered';
        return;
      }
      const delay = delays[Math.min(n, delays.length - 1)];
      if (outcome === 'stop' || now() + delay > deadline) {
        p.delivery = 'failed';
        log('warn', 'steam-otp-request-undelivered', { id: p.payload.id, store: p.payload.storeId, attempts: n + 1, why: outcome === 'stop' ? 'refused' : 'out-of-time' });
        return;
      }
      await sleep(delay);
    }
  }

  return {
    enabled: !!cfg,
    /** Makes (and starts delivering) a request for the store, or returns the one made in the last minute. */
    request(who: { storeId: string; storeName: string; accountUsername: string; accountEmail?: string }): OtpRequestState {
      const prev = byStore.get(who.storeId);
      if (prev && now() - prev.atMs < every) return { id: prev.payload.id, at: prev.payload.at, delivery: prev.delivery, duplicate: true };
      const atMs = now();
      const payload: OtpRequestPayload = {
        id: randomUUID(),
        type: 'steam.otp.requested',
        at: new Date(atMs).toISOString(),
        storeId: who.storeId,
        storeName: who.storeName,
        accountUsername: who.accountUsername,
        ...(who.accountEmail ? { accountEmail: who.accountEmail } : {}),
      };
      const p: Pending = { payload, atMs, delivery: 'pending' };
      byStore.set(who.storeId, p);
      void deliver(p).catch(() => {
        p.delivery = 'failed';
      });
      return { id: payload.id, at: payload.at, delivery: 'pending', duplicate: false };
    },
    /** When the store last asked, while that can still be answered. */
    requestedAt(storeId: string, nowMs: number): string | undefined {
      const p = byStore.get(storeId);
      return p && nowMs - p.atMs < REQUEST_WINDOW_MS ? p.payload.at : undefined;
    },
    close() {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const c of inflight) c.abort();
    },
  };
}
