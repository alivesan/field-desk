import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from './log.ts';
import { LOOKUP_GRACE_MS, LOOKUP_WINDOW_MS } from '../src/lib/steam.ts';

/*
 * The server's side of the Steam Guard (OTP) automation — see docs/steam-otp-api.md.
 *
 *   FD_STEAM_API_KEY          bearer token of the automation: the ONLY credential /api/v1/steam/* accepts
 *                             (and accepted nowhere else). Unset = those routes answer 503 not_configured.
 *   FD_STEAM_WEBHOOK_URL      where a store's "Get code" is sent (steam.otp.requested, and steam.otp.request.closed
 *   FD_STEAM_WEBHOOK_SECRET   when it ends early), signed with HMAC-SHA256 over the exact bytes sent. Both unset = the feature is off.
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
  /** A press within this long of the store's last lookup is that same lookup (a double tap). Default 5 s. */
  duplicateWithinMs?: number;
  /** Lookups one store may start in 10 minutes. Default 20. */
  maxLookupsPer10Min?: number;
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

/** Who a lookup is for: the store and the account its team signs in with. */
export interface OtpWho {
  storeId: string;
  storeName: string;
  accountUsername: string;
  accountEmail?: string;
}

export interface OtpRequestPayload {
  id: string;
  type: 'steam.otp.requested';
  at: string;
  /** = id and = at, under the names the automation's answers use. */
  requestId: string;
  requestedAt: string;
  /** Emails dated from here on (a minute before the lookup) may answer it; the automation watches until `watchUntil`. */
  acceptFrom: string;
  watchUntil: string;
  storeId: string;
  storeName: string;
  accountUsername: string;
  accountEmail?: string;
  /** Every store holding the account (any purpose, event day not past), sorted — `storeId` is one of them. */
  eligibleStoreIds?: string[];
}

export type OtpCloseReason = 'dismissed' | 'superseded';

export interface OtpClosePayload {
  id: string;
  type: 'steam.otp.request.closed';
  at: string;
  requestId: string;
  storeId: string;
  accountUsername: string;
  accountEmail?: string;
  reason: OtpCloseReason;
}

export type Delivery = 'pending' | 'delivered' | 'failed';

export interface OtpRequestState {
  id: string;
  at: string;
  delivery: Delivery;
}

/** One event on its way to the webhook: its bytes are made once; `stopped` ends the retries. */
interface Job {
  kind: 'request' | 'close';
  id: string;
  request: string;
  store: string;
  body: Buffer;
  signature: string;
  deadline: number;
  stopped: boolean;
  wake?: () => void;
}

/** A lookup started in the last 10 minutes: for the status answer and the per-store cap. */
interface Recent {
  storeId: string;
  atMs: number;
  closed?: OtpCloseReason;
  job: Job;
}

const DEFAULT_DELAYS = [5000, 15000, 45000, 90000];

/**
 * Delivers each lookup (a signed steam.otp.requested) to the webhook: 2xx done; a timeout, a network error or a 5xx
 * is tried again later with the same id and the very same bytes until 10 minutes after `at`; any other answer ends
 * it. A lookup that ends early (the team dismissed it, or started another) stops its retries and is followed by a
 * steam.otp.request.closed, delivered the same way but only while the lookup could still be watched. Which lookup a
 * store is on lives on the store document; this keeps only a short memory of the recent ones.
 */
export function createOtpRequests(cfg: SteamOtpConfig['webhook'], o: SteamOtpOptions, now: () => number, log: Logger) {
  const delays = o.retryDelaysMs?.length ? o.retryDelaysMs : DEFAULT_DELAYS;
  const timeoutMs = o.attemptTimeoutMs ?? 5000;
  const recent = new Map<string, Recent>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inflight = new Set<AbortController>();
  let closed = false;

  const sleep = (ms: number, job: Job) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(t);
        timers.delete(t);
        job.wake = undefined;
        resolve();
      };
      const t = setTimeout(wake, ms);
      t.unref();
      timers.add(t);
      job.wake = wake;
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

  async function deliver(job: Job) {
    for (let n = 0; !closed && !job.stopped; n++) {
      const outcome = await attempt(job.body, job.signature);
      if (closed || job.stopped) return;
      if (outcome === 'ok') {
        return;
      }
      const delay = delays[Math.min(n, delays.length - 1)];
      if (outcome === 'stop' || now() + delay > job.deadline) {
        if (job.kind === 'request') log('warn', 'steam-otp-request-undelivered', { id: job.id, store: job.store, attempts: n + 1, why: outcome === 'stop' ? 'refused' : 'out-of-time' });
        // A worker that doesn't know the event answers 400 unsupported_event: expected, and final.
        else log('info', outcome === 'stop' ? 'steam-otp-close-refused' : 'steam-otp-close-undelivered', { id: job.id, request: job.request, store: job.store });
        return;
      }
      await sleep(delay, job);
    }
  }

  /** The bytes are made once: every retry sends exactly these, with the signature over exactly these. */
  function send(kind: Job['kind'], payload: OtpRequestPayload | OtpClosePayload, request: string, store: string, deadline: number): Job {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = `sha256=${createHmac('sha256', cfg!.secret).update(body).digest('hex')}`;
    const job: Job = { kind, id: payload.id, request, store, body, signature, deadline, stopped: false };
    void deliver(job).catch(() => {});
    return job;
  }

  const prune = () => {
    for (const [id, r] of recent) if (now() - r.atMs >= LOOKUP_WINDOW_MS) recent.delete(id);
  };

  return {
    enabled: !!cfg,
    /** Starts a new lookup for the store (always a new id) and delivers its event. */
    request(who: OtpWho, eligibleStoreIds?: string[]): OtpRequestState {
      prune();
      const atMs = now();
      const at = new Date(atMs).toISOString();
      const id = randomUUID();
      const payload: OtpRequestPayload = {
        id,
        type: 'steam.otp.requested',
        at,
        requestId: id,
        requestedAt: at,
        acceptFrom: new Date(atMs - LOOKUP_GRACE_MS).toISOString(),
        watchUntil: new Date(atMs + LOOKUP_WINDOW_MS).toISOString(),
        storeId: who.storeId,
        storeName: who.storeName,
        accountUsername: who.accountUsername,
        ...(who.accountEmail ? { accountEmail: who.accountEmail } : {}),
        ...(eligibleStoreIds ? { eligibleStoreIds } : {}),
      };
      const job = send('request', payload, id, who.storeId, atMs + LOOKUP_WINDOW_MS);
      recent.set(id, { storeId: who.storeId, atMs, job });
      return { id, at, delivery: 'pending' };
    },
    /** Ends a lookup early: its retries stop and the automation is told — unless its watch has run out anyway. */
    closeRequest(id: string, reason: OtpCloseReason, who: OtpWho & { requestedAt: string }) {
      prune();
      const known = recent.get(id);
      if (known) {
        known.closed = reason;
        known.job.stopped = true;
        known.job.wake?.();
      }
      const deadline = Date.parse(who.requestedAt) + LOOKUP_WINDOW_MS;
      if (now() >= deadline) return;
      const payload: OtpClosePayload = {
        id: randomUUID(),
        type: 'steam.otp.request.closed',
        at: new Date(now()).toISOString(),
        requestId: id,
        storeId: who.storeId,
        accountUsername: who.accountUsername,
        ...(who.accountEmail ? { accountEmail: who.accountEmail } : {}),
        reason,
      };
      send('close', payload, id, who.storeId, deadline);
    },
    /** What is remembered of a recent lookup: its store, and why it ended if it did. */
    status(id: string): { storeId: string; closed?: OtpCloseReason } | undefined {
      prune();
      const r = recent.get(id);
      return r && { storeId: r.storeId, closed: r.closed };
    },
    /** How many lookups the store started in the last 10 minutes. */
    recentCount(storeId: string): number {
      prune();
      let n = 0;
      for (const r of recent.values()) if (r.storeId === storeId) n++;
      return n;
    },
    close() {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const c of inflight) c.abort();
    },
  };
}
