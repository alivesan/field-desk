import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { applyOps, diffDocs, DOC_KINDS, safeParse, validateOps, type Docs, type DocKind, type Op } from '../src/lib/ops.ts';
import { ADMIN_CODE, normalizeStore, validateDocument } from '../src/lib/schema.ts';
import { applyCommand, COMMAND_ROLES, CommandError, validateCommand, type Command, type CommandContext } from '../src/lib/commands.ts';
import type { Store, ToornamentSource } from '../src/lib/types.ts';
import { AUTO_ACTOR } from '../src/lib/toornament-auto.ts';
import { openDatabase, photoIds } from './migrate.ts';
import { acquireLock } from './lock.ts';
import { createSessions, hashToken, TOKEN } from './sessions.ts';
import { clientIp, createLoginLimiter, DEFAULT_LIMITS, type LimitConfig, type LoginKind } from './ratelimit.ts';
import { createPhotoStore, PhotoConflict, PhotoQuota } from './photos.ts';
import { consoleLogger, errorFields, type Logger } from './log.ts';
import { createPublicLimiter, DEFAULT_PUBLIC_LIMITS, selfCheckIn, storeByToken, type PublicLimitConfig } from './public.ts';
import { fetchRoster, RosterFetchError, type RosterFetchOptions } from './roster-fetch.ts';
import { fetchToornament } from './toornament-fetch.ts';
import { createToornamentAuto, type ToornamentAutoOptions } from './toornament-auto.ts';
import { lanOrigins, listensOnAll } from './lan.ts';

export { ADMIN_CODE };

/*
 * Field Desk API. Plain node:http handler so the same code runs inside the Vite dev
 * server and in production (server/index.ts).
 *
 * Two roles:
 *   super  — HQ. Signs in with SUPER_ADMIN_CODE. Reads and writes everything.
 *   admin  — a field admin. Signs in with their personal 4-character code (the link
 *            HQ shares: https://host/K7Q2). Sees only the stores assigned to them and
 *            their events, and may only write those stores' recce / match-day data.
 * Every read, write, stream message and photo is checked here, not just hidden in the UI.
 *
 *   GET  /api/me              { role, principal, name?, expiresAt } | { role: null }
 *   POST /api/login           { code } -> session cookie, { ok, role, principal, expiresAt }
 *   POST /api/logout          revokes this session
 *   GET  /api/lan             signed in: { origins } — this machine's Wi-Fi addresses, for links made on localhost
 *   GET  /api/state           snapshot the caller may see { seq, principal, events, stores, admins }
 *   POST /api/batch           { id, ops } -> { seq }    field edits; idempotent per (id, payload)
 *   POST /api/command         { id, storeId, cmd } -> { seq }   tournament / submission commands
 *   GET  /api/stream          server-sent events: every commit, filtered per caller
 *   PUT  /api/photos/:id?store=<storeId>   jpeg body (write-once, owned by that store)
 *   GET  /api/photos/:id
 *   GET  /api/roster/fetch?url=<https link>   HQ only: { url, contentType, text, fetchedAt } (server/roster-fetch.ts)
 *   GET  /api/toornament/fetch?url=<toornament link>&stage=<stageId>   HQ only: tournament, stages,
 *        participants, the stage's first round (server/toornament-fetch.ts, src/lib/toornament.ts)
 *
 * No request for these: from 12:30 on a store's day the server checks its Toornament stage every 5
 * minutes and loads the bracket once the players are placed (server/toornament-auto.ts; off in
 * tests unless asked for). It commits as the system actor 'system:toornament', like any command.
 *
 * Public — no session, for players at the venue (server/public.ts has the limits):
 *   GET  /api/public/checkin/:token   { store, campaign, date, open } — nothing about players
 *   POST /api/public/checkin/:token   { phone } -> { ok, name: "First L.", already }
 *
 * Errors are JSON { code, error, ... }: bad-request / invalid (+ problems) 400, unauthenticated
 * 401, forbidden / protected / closed 403, not-found / no-match 404, batch-id-reused / conflict /
 * photo-exists / ambiguous 409, too-large 413, unsupported-media 415, rate-limited 429,
 * upstream 502; bad-url / blocked-host 400 (roster / Toornament fetch).
 *
 * Every commit (batch or command) validates each document it touches — the whole resulting
 * document, see src/lib/schema.ts — before anything is written; a document that already had
 * problems (legacy data) may be edited as long as the edit adds no new ones.
 */

export interface ApiOptions {
  dataDir: string;
  superCode: string; // HQ's sign-in code. There is no open mode: no session = no access.
  /** Session cookie name (COOKIE_NAME). Default fd_session. */
  cookieName?: string;
  /** Trusted reverse-proxy hops in front of the server (TRUST_PROXY). Default 0: X-Forwarded-For ignored. */
  trustProxy?: number;
  /** Session lifetimes in days (SESSION_DAYS_ADMIN / SESSION_DAYS_SUPER). Proposed defaults 30 / 7. */
  sessionDays?: { admin?: number; super?: number };
  /** Largest photo upload in bytes (MAX_PHOTO_MB). Default 15 MB. */
  maxPhotoBytes?: number;
  /** Photos per store (MAX_PHOTOS_PER_STORE). Default 500. */
  maxPhotosPerStore?: number;
  loginLimits?: Partial<LimitConfig>;
  /** Player self check-in limits (server/public.ts). */
  publicLimits?: Partial<PublicLimitConfig>;
  /** Roster link and Toornament fetches: DNS / transport / limits, for tests (server/roster-fetch.ts). */
  rosterFetch?: RosterFetchOptions;
  /** The Toornament auto-check (server/toornament-auto.ts). Off unless `enabled` — server/index.ts turns it on. */
  toornamentAuto?: ToornamentAutoOptions;
  /** How often open event streams are pinged and their sessions re-checked. Default 20 s. */
  streamCheckMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  log?: Logger;
}

type Who = { role: 'super'; principal: 'super' | typeof AUTO_ACTOR.principal; name: string } | { role: 'admin'; principal: string; id: string; name: string };
interface Session {
  hash: string;
  who: Who;
  expiresAt: number;
}

/** The server acting on its own (the Toornament auto-check): HQ's powers, but never a session. */
const SYSTEM: Who = { role: 'super', principal: AUTO_ACTOR.principal, name: AUTO_ACTOR.name };

const BATCH_ID = /^[\w-]{6,60}$/;
/** Shorter: handlers derive ids from it (match `${id}-r-i`, submission `sub-${id}`), which must stay ≤ 64. */
const COMMAND_ID = /^[\w-]{6,48}$/;
const PHOTO_ID = /^[a-z0-9]{6,40}$/;
const MAX_JSON = 4 * 1024 * 1024;
/** Store fields a field admin may change. Everything else (name, assignment…) is HQ's. */
const ADMIN_WRITABLE = new Set(['recce', 'day', 'pin', 'updatedAt']);
/** Store state that changes only through commands — never through generic batches, from anyone. */
const PROTECTED: [string, (s: any) => unknown][] = [
  ['day.players', (s) => s?.day?.players ?? []],
  ['day.matches', (s) => s?.day?.matches ?? []],
  ['day.stations', (s) => s?.day?.stations ?? null],
  ['day.version', (s) => s?.day?.version ?? 0],
  ['day.onSpot', (s) => s?.day?.onSpot ?? []], // on-the-spot registrations: players.onspot / onspot.mark
  ['day.winners', (s) => s?.day?.winners ?? null], // winner + runner-up details: winners.set
  ['submissions', (s) => s?.submissions ?? []],
];

const envNum = (name: string) => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

/** JSON with object keys sorted — equal values give equal text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function createApi(opts: ApiOptions) {
  const { dataDir, superCode } = opts;
  if (!superCode?.trim()) throw new Error('createApi needs a super admin code');
  const now = opts.now ?? Date.now;
  const log = opts.log ?? consoleLogger;
  const cookieName = opts.cookieName ?? process.env.COOKIE_NAME ?? 'fd_session';
  if (!/^[\w-]{1,64}$/.test(cookieName)) throw new Error('COOKIE_NAME may only use letters, digits, _ and -');
  const trustProxy = opts.trustProxy ?? envNum('TRUST_PROXY') ?? 0;
  const ttl = {
    admin: (opts.sessionDays?.admin ?? envNum('SESSION_DAYS_ADMIN') ?? 30) * 864e5,
    super: (opts.sessionDays?.super ?? envNum('SESSION_DAYS_SUPER') ?? 7) * 864e5,
  };
  const maxPhoto = opts.maxPhotoBytes ?? (envNum('MAX_PHOTO_MB') ?? 15) * 1024 * 1024;
  const maxPhotosPerStore = opts.maxPhotosPerStore ?? envNum('MAX_PHOTOS_PER_STORE') ?? 500;

  fs.mkdirSync(dataDir, { recursive: true });
  const releaseLock = acquireLock(dataDir, (msg) => log('warn', 'stale-lock', { message: msg }));
  let db: ReturnType<typeof openDatabase>['db'];
  try {
    db = openDatabase(dataDir, log).db;
  } catch (e) {
    releaseLock();
    throw e;
  }
  db.prepare('DELETE FROM batches WHERE at < ?').run(now() - 30 * 864e5);

  const meta = (k: string) => (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
  if (!meta('secret')) setMeta.run('secret', randomBytes(32).toString('hex'));
  const secret = meta('secret')!;
  const sign = (s: string) => createHmac('sha256', secret).update(s).digest('hex');

  let seq = Number(meta('seq') ?? 0);
  let docs: Docs = { events: {}, stores: {}, admins: {} };
  for (const row of db.prepare('SELECT kind, id, data FROM docs').all() as { kind: DocKind; id: string; data: string }[]) {
    if (!DOC_KINDS.includes(row.kind)) continue;
    const doc = JSON.parse(row.data);
    docs[row.kind][row.id] = row.kind === 'stores' ? normalizeStore(doc) : doc;
  }

  const upsert = db.prepare('INSERT INTO docs (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data');
  const remove = db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?');
  const findBatch = db.prepare('SELECT seq, hash FROM batches WHERE id = ?');
  const addBatch = db.prepare('INSERT INTO batches (id, seq, at, hash) VALUES (?, ?, ?, ?)');

  const sessions = createSessions(db, now);
  sessions.prune();
  const photos = createPhotoStore(db, path.join(dataDir, 'photos'), now);
  const limiter = createLoginLimiter({ ...DEFAULT_LIMITS, ...opts.loginLimits }, now);
  const publicLimiter = createPublicLimiter({ ...DEFAULT_PUBLIC_LIMITS, ...opts.publicLimits }, now);

  /* ---------- sessions ---------- */

  // Fingerprint of the code a session was made with: rotating a code ends its sessions.
  const superFp = sign(`super:${superCode}`);
  const adminFp = (a: { id: string; code: string }) => sign(`admin:${a.id}:${a.code}`);
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  sessions.revokeAllExcept('super', superFp); // SUPER_ADMIN_CODE changed → HQ signs in again (and changing it back doesn't revive old sessions)

  function sessionByHash(hash: string): Session | null {
    const row = sessions.find(hash);
    if (!row) return null;
    if (row.principal === 'super') return same(row.fp, superFp) ? { hash, who: { role: 'super', principal: 'super', name: 'HQ' }, expiresAt: row.expires_at } : null;
    const a = row.principal.startsWith('admin:') ? docs.admins[row.principal.slice(6)] : undefined;
    if (!a || !same(row.fp, adminFp(a))) return null;
    return { hash, who: { role: 'admin', principal: row.principal, id: a.id, name: a.name }, expiresAt: row.expires_at };
  }

  function cookies(req: IncomingMessage) {
    const out: Record<string, string> = {};
    for (const c of (req.headers.cookie ?? '').split(/;\s*/)) {
      const i = c.indexOf('=');
      if (i <= 0) continue;
      try {
        out[c.slice(0, i)] = decodeURIComponent(c.slice(i + 1));
      } catch {
        /* malformed cookie: ignore it */
      }
    }
    return out;
  }
  const sessionOf = (req: IncomingMessage) => {
    const raw = cookies(req)[cookieName];
    return raw && TOKEN.test(raw) ? sessionByHash(hashToken(raw)) : null;
  };
  const isHttps = (req: IncomingMessage) => !!(req.socket as { encrypted?: boolean }).encrypted || (trustProxy > 0 && req.headers['x-forwarded-proto'] === 'https');
  const cookie = (req: IncomingMessage, value: string, maxAgeS: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`;

  /* ---------- visibility ---------- */

  const storesOf = (adminId: string) => Object.values(docs.stores).filter((s) => s.adminId === adminId);

  /**
   * Admins see a player's full number only once the player is checked in (at the desk or by QR) —
   * then they may need to call them. Before that they get the last 4 digits, enough to tell people
   * apart. QR check-in matches numbers on the server, so it doesn't need the client to have them.
   */
  function phonesForAdmins(day: Store['day']): Store['day'] {
    if (!day?.players) return day;
    const here = (id: string) => !!day.checkIn?.[id];
    const players = day.players.map((p) => {
      if (!p.phone || here(p.id)) return p;
      const { phone, ...rest } = p;
      return { ...rest, phoneEnd: phone.slice(-4) };
    });
    const onSpot = day.onSpot?.map((e) => {
      if (!e.phone || here(e.playerId)) return e;
      const { phone: _hidden, ...rest } = e;
      return rest;
    });
    return { ...day, players, ...(onSpot ? { onSpot } : {}) };
  }

  function visibleDocs(who: Who): Docs {
    if (who.role === 'super') return docs;
    const stores = storesOf(who.id);
    const eventIds = new Set(stores.map((s) => s.eventId));
    // HQ's source links (the campaign's store sheet, a store's player-list link) are capabilities —
    // anyone holding a published-sheet link can read the whole sheet — so they never reach admins.
    return {
      events: Object.fromEntries(
        Object.entries(docs.events)
          .filter(([id]) => eventIds.has(id))
          .map(([id, e]) => {
            const { storeSheet: _hq, ...rest } = e as typeof e & { storeSheet?: unknown };
            return [id, rest as typeof e];
          }),
      ),
      stores: Object.fromEntries(
        stores.map((s) => {
          const { roster: _hq, ...rest } = s;
          return [s.id, { ...rest, day: phonesForAdmins(rest.day) } as typeof s];
        }),
      ),
      admins: {},
    };
  }

  const canWriteStore = (who: Who, storeId: string) => who.role === 'super' || docs.stores[storeId]?.adminId === who.id;

  /** Rejects any op a field admin isn't allowed to make. Uses only op.k, op.id and op.p[0]. */
  function authorize(who: Who, ops: Op[]) {
    if (who.role === 'super') return;
    for (const op of ops) {
      if (op.k !== 'stores' || !canWriteStore(who, op.id)) throw new HttpError(403, 'forbidden', 'That store isn’t assigned to you.');
      if (!op.p.length || !ADMIN_WRITABLE.has(String(op.p[0]))) throw new HttpError(403, 'forbidden', `Only HQ can change “${op.p[0] ?? 'the store'}”.`);
    }
  }

  /** Changes that alter who can see what — field admins refetch their snapshot. */
  const structural = (ops: Op[]) =>
    ops.some((o) => o.k === 'admins' || (o.k === 'events' && !o.p.length) || (o.k === 'stores' && (!o.p.length || o.p[0] === 'adminId' || o.p[0] === 'eventId')));

  /* ---------- writes ---------- */

  const streams = new Map<ServerResponse, string>(); // stream -> session id hash
  const closeStream = (res: ServerResponse) => {
    res.write(`data: ${JSON.stringify({ seq, id: '', ops: [], resync: true })}\n\n`);
    res.end();
    streams.delete(res);
  };
  const ticker = setInterval(() => {
    for (const [res, hash] of streams) {
      if (!sessionByHash(hash)) closeStream(res);
      // A named event (browsers drop comment-only keepalives) carrying seq, so a quiet but live
      // board can show it is current, and a client that missed something can tell.
      else res.write(`event: ping\ndata: ${seq}\n\n`);
    }
  }, opts.streamCheckMs ?? 20000);
  ticker.unref();
  const pruner = setInterval(() => sessions.prune(), 3600000);
  pruner.unref();

  /** A retry of something already committed returns its seq; reusing an id for a different payload is refused. */
  function seen(key: string, hash: string) {
    const row = findBatch.get(key) as { seq: number; hash: string | null } | undefined;
    if (!row) return undefined;
    if (row.hash === null || row.hash === hash) return row.seq; // hash null: committed before payload hashes existed
    throw new HttpError(409, 'batch-id-reused', 'This id was already used for different changes. Send new changes with a new id.');
  }

  const docProblems = (k: DocKind, doc: unknown, from: Docs) => validateDocument(k, doc, { events: from.events, admins: from.admins, stores: from.stores });

  /**
   * Checks the documents a commit touches, against the state it would produce. Throws:
   * 403 protected — a batch changed command-only store state; 400 invalid — any new problem,
   * including a newly referenced photo that isn't registered to that store.
   */
  function check(work: Docs, touched: Map<string, [DocKind, string]>, protect: boolean) {
    const problems: string[] = [];
    for (const [k, id] of touched.values()) {
      const doc = work[k][id];
      const prev = docs[k][id];
      if (!doc) continue;
      if (k === 'stores' && protect) {
        // A new store may pick its station count; everything else starts empty.
        const changed = PROTECTED.filter(([p, get]) => (prev || p !== 'day.stations') && canonical(get(prev ?? {})) !== canonical(get(doc))).map(([p]) => p);
        if (changed.length) {
          throw new HttpError(403, 'protected', `${changed.join(', ')} change only through commands (POST /api/command).`, { paths: changed.map((p) => `stores/${id}.${p}`) });
        }
      }
      if (doc.id !== id) problems.push(`${k}/${id}: id: must match the document id`);
      const before = prev ? new Set(docProblems(k, prev, docs)) : new Set<string>();
      for (const p of docProblems(k, doc, work)) if (!before.has(p)) problems.push(`${k}/${id}: ${p}`);
      if (k === 'stores') {
        const had = prev ? photoIds(prev) : new Set<string>();
        for (const pid of photoIds(doc)) {
          if (had.has(pid)) continue;
          if (photos.row(pid)?.store_id !== id) problems.push(`${k}/${id}: photo ${pid} hasn’t been uploaded for this store`);
        }
      }
    }
    // A campaign or admin change can break stores that point at it.
    if ([...touched.values()].some(([k]) => k !== 'stores')) {
      for (const [id, s] of Object.entries(work.stores)) {
        if (touched.has(`stores/${id}`)) continue;
        const before = new Set(docProblems('stores', s, docs));
        for (const p of docProblems('stores', s, work)) if (!before.has(p)) problems.push(`stores/${id}: ${p}`);
      }
    }
    if (problems.length) throw new HttpError(400, 'invalid', problems.length === 1 ? problems[0] : `${problems.length} problems — first: ${problems[0]}`, { problems: problems.slice(0, 50) });
  }

  /** Writes the touched documents and the dedupe record in one transaction, then publishes. */
  function commit(key: string, hash: string, work: Docs, touched: Map<string, [DocKind, string]>, id: string, ops: Op[]) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [k, docId] of touched.values()) {
        const doc = work[k][docId];
        if (doc) upsert.run(k, docId, JSON.stringify(doc));
        else remove.run(k, docId);
      }
      setMeta.run('seq', String(seq + 1));
      addBatch.run(key, seq + 1, now(), hash);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    seq += 1;
    const prev = docs;
    docs = work;
    // A changed or removed admin code ends that admin's sessions for good.
    for (const [k, docId] of touched.values()) {
      if (k !== 'admins' || prev.admins[docId]?.code === work.admins[docId]?.code) continue;
      sessions.revokeAllExcept(`admin:${docId}`, work.admins[docId] ? adminFp(work.admins[docId]) : '');
    }
    broadcast(seq, id, ops);
    return seq;
  }

  // Copies of the collections, with the touched documents cloned, so a failure leaves memory untouched.
  function workCopy(keys: [DocKind, string][]) {
    const work: Docs = { events: { ...docs.events }, stores: { ...docs.stores }, admins: { ...docs.admins } };
    const touched = new Map<string, [DocKind, string]>();
    for (const [k, id] of keys) {
      const key = `${k}/${id}`;
      if (touched.has(key)) continue;
      touched.set(key, [k, id]);
      if (work[k][id]) work[k][id] = structuredClone(work[k][id]);
    }
    return { work, touched };
  }

  function applyBatch(who: Who, id: string, ops: Op[]) {
    const hash = sha256(canonical({ ops }));
    const prior = seen(id, hash);
    if (prior !== undefined) return prior;
    authorize(who, ops);
    const { work, touched } = workCopy(ops.map((o) => [o.k, o.id]));
    applyOps(work, ops);
    // normalizeStore seeds day.checkInSource when stores load; seed it on write too (and tell every
    // client), so memory matches what a restart loads and edits stay per-player paths.
    const seeded: Op[] = [];
    for (const [k, docId] of touched.values()) {
      const day = k === 'stores' ? (work.stores[docId] as { day?: unknown } | undefined)?.day : undefined;
      if (!day || typeof day !== 'object' || Array.isArray(day) || (day as Record<string, unknown>).checkInSource !== undefined) continue;
      (day as Record<string, unknown>).checkInSource = {};
      seeded.push({ k: 'stores', id: docId, p: ['day', 'checkInSource'], v: {} });
    }
    check(work, touched, true);
    return commit(id, hash, work, touched, id, [...ops, ...seeded]);
  }

  /** `also` may adjust the resulting store (e.g. the auto-check's record of what it did) — it commits with the command. */
  function runCommand(who: Who, id: string, storeId: string, cmd: Command, also?: (next: Store) => void) {
    const hash = sha256(canonical({ storeId, cmd }));
    const prior = seen(`cmd:${id}`, hash);
    if (prior !== undefined) return prior;
    const store = docs.stores[storeId] as Store | undefined;
    if (!store) throw new HttpError(404, 'not-found', 'No such store.');
    if (!canWriteStore(who, storeId)) throw new HttpError(403, 'forbidden', 'That store isn’t assigned to you.');
    if (!COMMAND_ROLES[cmd.type]?.includes(who.role)) throw new HttpError(403, 'forbidden', `Only HQ can ${cmd.type}.`);
    const event = docs.events[store.eventId];
    if (!event) throw new HttpError(400, 'invalid', `This store’s campaign ${store.eventId} doesn’t exist.`);
    const ctx: CommandContext = { commandId: id, now: new Date(now()).toISOString(), actor: { principal: who.principal, name: who.name, role: who.role }, event: structuredClone(event) };
    let next: Store;
    try {
      next = applyCommand(structuredClone(store), cmd, ctx);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      throw new HttpError(e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400, e.code, e.message);
    }
    also?.(next);
    const { work, touched } = workCopy([['stores', storeId]]);
    work.stores[storeId] = next;
    check(work, touched, false);
    const ops = diffDocs({ events: {}, stores: { [storeId]: store }, admins: {} }, { events: {}, stores: { [storeId]: next }, admins: {} });
    return commit(`cmd:${id}`, hash, work, touched, id, ops);
  }

  /** A server-made change to a store's Toornament record (the auto-check's status): validated and committed like a batch, so every client hears of it. */
  function recordToornament(storeId: string, edit: (t: ToornamentSource) => void) {
    const store = docs.stores[storeId];
    if (!store?.toornament) return;
    const { work, touched } = workCopy([['stores', storeId]]);
    edit(work.stores[storeId].toornament!);
    const ops = diffDocs({ events: {}, stores: { [storeId]: store }, admins: {} }, { events: {}, stores: { [storeId]: work.stores[storeId] }, admins: {} });
    if (!ops.length) return;
    check(work, touched, true);
    const id = `auto-${randomBytes(9).toString('base64url')}`;
    commit(id, sha256(canonical({ ops })), work, touched, id, ops);
  }

  const toornamentAuto = createToornamentAuto(
    {
      stores: () => Object.values(docs.stores),
      store: (id) => docs.stores[id],
      event: (id) => docs.events[id],
      apply: (storeId, commandId, cmd, edit) => void runCommand(SYSTEM, commandId, storeId, cmd, (next) => next.toornament && edit(next.toornament)),
      record: recordToornament,
    },
    { now: () => new Date(now()), ...opts.toornamentAuto, rosterFetch: { now, ...opts.rosterFetch }, log },
  );
  if (opts.toornamentAuto?.enabled) toornamentAuto.start();

  // Every client gets every seq (so it can spot gaps), with only the ops it may see.
  function broadcast(n: number, id: string, ops: Op[]) {
    const full = `data: ${JSON.stringify({ seq: n, id, ops })}\n\n`;
    const resync = structural(ops);
    for (const [res, hash] of streams) {
      const s = sessionByHash(hash);
      if (!s) closeStream(res);
      else if (s.who.role === 'super') res.write(full);
      else {
        // Admins get each changed doc as their filtered copy (visibleDocs), never the raw ops: a raw
        // op can carry what their snapshot leaves out (phones before check-in, HQ's sheet links),
        // and a check-in must also deliver that player's number, which the op itself doesn't hold.
        const vis = visibleDocs(s.who);
        const seen = new Set<string>();
        const mine: Op[] = [];
        for (const o of ops) {
          const key = `${o.k}/${o.id}`;
          if (o.k === 'admins' || seen.has(key) || !vis[o.k][o.id]) continue;
          seen.add(key);
          mine.push({ k: o.k, id: o.id, p: [], v: vis[o.k][o.id] });
        }
        res.write(`data: ${JSON.stringify({ seq: n, id, ops: resync ? [] : mine, resync: resync || undefined })}\n\n`);
      }
    }
  }

  /* ---------- handler ---------- */

  async function readJson(req: IncomingMessage, limit: number) {
    const text = (await readRaw(req, limit)).toString('utf8') || '{}';
    try {
      return safeParse(text);
    } catch {
      throw new HttpError(400, 'bad-request', 'Body isn’t valid JSON.');
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      if (!(req.url ?? '').startsWith('/api/')) return false;
      return send(res, 400, { code: 'bad-request', error: 'Malformed URL' });
    }
    if (!url.pathname.startsWith('/api/')) return false;
    const route = `${req.method} ${url.pathname}`;

    // Reject cross-site writes.
    if (req.method !== 'GET' && req.headers.origin) {
      let host: string | null = null;
      try {
        host = new URL(req.headers.origin).host;
      } catch {
        /* bad origin */
      }
      // HTTP/2 (what phones use over https) carries the host as :authority, not a Host header.
      const own = req.headers.host ?? req.headers[':authority'];
      if (host === null || host !== own) return send(res, 403, { code: 'forbidden', error: 'Cross-origin request refused' });
    }

    // Players at the venue: no session, whoever's cookie this browser happens to carry.
    const checkin = url.pathname.match(/^\/api\/public\/checkin\/([^/]+)$/);
    if (checkin) return publicCheckIn(req, res, checkin[1]);

    const session = sessionOf(req);
    const who = session?.who ?? null;

    if (route === 'GET /api/me') {
      return send(res, 200, session ? { role: session.who.role, principal: session.who.principal, name: session.who.name, expiresAt: new Date(session.expiresAt).toISOString(), seq } : { role: null });
    }

    if (route === 'GET /api/lan') {
      if (!who) return send(res, 401, { code: 'unauthenticated', error: 'Sign-in required' });
      // Bound to localhost only (plain `npm run dev`)? Then phones can't reach it whatever the address.
      const local = req.socket.localAddress ?? '';
      const reachable = !(local === '127.0.0.1' || local === '::1' || local === '::ffff:127.0.0.1') || listensOnAll(req);
      const https = !!(req.socket as { encrypted?: boolean }).encrypted;
      return send(res, 200, { origins: lanOrigins(https ? 'https' : 'http', req.socket.localPort ?? 80), reachable, https });
    }

    // The client names the identity it believes it is acting for. If the cookie now belongs to
    // someone else (another tab signed in as a different person), refuse rather than write under them.
    const claimed = req.headers['x-field-desk-principal'];
    if (who && typeof claimed === 'string' && claimed && claimed !== who.principal && route !== 'POST /api/login' && route !== 'POST /api/logout') {
      return send(res, 409, { code: 'principal-mismatch', error: 'This device is now signed in as someone else — reload to continue.' });
    }

    if (route === 'POST /api/login') {
      const ip = clientIp(req, trustProxy);
      const body = await readJson(req, 10000);
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      const kind: LoginKind = ADMIN_CODE.test(code.toUpperCase()) && !same(code, superCode) ? 'admin' : 'hq';
      const wait = limiter.blockedFor(ip, kind);
      if (wait) {
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        return send(res, 429, { code: 'rate-limited', error: 'Too many wrong codes — try again in a few minutes.' });
      }
      let principal: string | null = null;
      let fp = '';
      if (kind === 'admin') {
        const a = Object.values(docs.admins).find((x) => typeof x.code === 'string' && same(x.code, code.toUpperCase()));
        if (a) [principal, fp] = [`admin:${a.id}`, adminFp(a)];
      } else if (same(code, superCode)) [principal, fp] = ['super', superFp];
      if (!principal) {
        limiter.fail(ip, kind);
        log('warn', 'login-failed', { kind, ip });
        return send(res, 401, { code: 'unauthenticated', error: kind === 'admin' ? 'That link or code isn’t valid any more — ask HQ for a new one.' : 'That code isn’t right.' });
      }
      limiter.succeed(ip, kind);
      if (session) sessions.revoke(session.hash); // signing in again replaces this browser's session
      const role = principal === 'super' ? 'super' : 'admin';
      const s = sessions.create(principal, fp, ttl[role]);
      res.setHeader('Set-Cookie', cookie(req, s.raw, Math.floor(ttl[role] / 1000)));
      log('info', 'login', { principal });
      return send(res, 200, { ok: true, role, principal, expiresAt: new Date(s.expiresAt).toISOString() });
    }

    if (route === 'POST /api/logout') {
      const raw = cookies(req)[cookieName];
      if (raw && TOKEN.test(raw)) {
        const hash = hashToken(raw);
        sessions.revoke(hash);
        for (const [r, h] of streams) if (h === hash) closeStream(r);
      }
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      return send(res, 200, { ok: true });
    }

    if (!session || !who) return send(res, 401, { code: 'unauthenticated', error: 'Sign-in required' });

    if (route === 'GET /api/state') return send(res, 200, { seq, principal: who.principal, ...visibleDocs(who) });

    if (route === 'POST /api/batch') {
      const body = await readJson(req, MAX_JSON);
      if (typeof body?.id !== 'string' || !BATCH_ID.test(body.id)) throw new HttpError(400, 'bad-request', 'bad batch id (6–60 letters, digits, _ or -)');
      let ops: Op[];
      try {
        ops = validateOps(body.ops);
      } catch (e) {
        throw new HttpError(400, 'bad-request', (e as Error).message);
      }
      return send(res, 200, { seq: applyBatch(who, body.id, ops) });
    }

    if (route === 'POST /api/command') {
      const body = await readJson(req, MAX_JSON);
      if (typeof body?.id !== 'string' || !COMMAND_ID.test(body.id)) throw new HttpError(400, 'bad-request', 'bad command id (6–48 letters, digits, _ or -)');
      if (typeof body.storeId !== 'string' || !/^[\w-]{1,64}$/.test(body.storeId)) throw new HttpError(400, 'bad-request', 'bad store id');
      let cmd: Command;
      try {
        cmd = validateCommand(body.cmd);
      } catch (e) {
        if (e instanceof CommandError) throw new HttpError(400, 'invalid', e.message);
        throw e;
      }
      return send(res, 200, { seq: runCommand(who, body.id, body.storeId, cmd) });
    }

    if (route === 'GET /api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n: connected at seq ${seq}\n\n`);
      streams.set(res, session.hash);
      req.on('close', () => streams.delete(res));
      return true;
    }

    // HQ pastes a short Maps link (maps.app.goo.gl/…): follow its redirects to the full
    // URL so the app can read the coordinates. Only ever talks to Google Maps hosts.
    if (route === 'GET /api/resolve-map') {
      if (who.role !== 'super') return send(res, 403, { code: 'forbidden', error: 'HQ only' });
      const mapsHost = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?)$/i;
      let cur: URL;
      try {
        cur = new URL(url.searchParams.get('url') ?? '');
      } catch {
        return send(res, 400, { code: 'bad-request', error: 'Not a link' });
      }
      for (let hop = 0; hop < 6; hop++) {
        if (cur.protocol !== 'https:' || !mapsHost.test(cur.hostname)) return send(res, 400, { code: 'bad-request', error: 'Only Google Maps links' });
        let r: Response;
        try {
          r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0 (FieldDesk)' } });
        } catch {
          return send(res, 502, { code: 'upstream', error: 'Couldn’t reach Google Maps' });
        }
        const next = r.headers.get('location');
        if (r.status < 300 || r.status >= 400 || !next) break;
        try {
          cur = new URL(next, cur);
        } catch {
          break;
        }
      }
      return send(res, 200, { url: cur.href });
    }

    if (route === 'GET /api/roster/fetch') {
      if (who.role !== 'super') return send(res, 403, { code: 'forbidden', error: 'HQ only' });
      try {
        return send(res, 200, await fetchRoster(url.searchParams.get('url') ?? '', { now, ...opts.rosterFetch }));
      } catch (e) {
        if (!(e instanceof RosterFetchError)) throw e;
        log('warn', 'roster-fetch-failed', { code: e.code, status: e.status }); // never the link: published-sheet ids are capabilities
        return send(res, e.status, { code: e.code, error: e.message, ...e.extra });
      }
    }

    if (route === 'GET /api/toornament/fetch') {
      if (who.role !== 'super') return send(res, 403, { code: 'forbidden', error: 'HQ only' });
      try {
        const stage = url.searchParams.get('stage') || undefined;
        return send(res, 200, await fetchToornament(url.searchParams.get('url') ?? '', stage, { now, ...opts.rosterFetch }));
      } catch (e) {
        if (!(e instanceof RosterFetchError)) throw e;
        log('warn', 'toornament-fetch-failed', { code: e.code, status: e.status });
        return send(res, e.status, { code: e.code, error: e.message, ...e.extra });
      }
    }

    const photo = url.pathname.match(/^\/api\/photos\/([^/]+)$/);
    if (photo) {
      const id = photo[1];
      if (!PHOTO_ID.test(id)) return send(res, 400, { code: 'bad-request', error: 'bad photo id' });
      if (req.method === 'PUT') {
        const storeId = url.searchParams.get('store') ?? '';
        if (!docs.stores[storeId]) return send(res, 400, { code: 'bad-request', error: 'Say which store the photo is for: ?store=<storeId>' });
        if (!canWriteStore(who, storeId)) return send(res, 403, { code: 'forbidden', error: 'That store isn’t assigned to you.' });
        if (req.headers['content-type'] !== 'image/jpeg') return send(res, 415, { code: 'unsupported-media', error: 'jpeg only' });
        const buf = await readRaw(req, maxPhoto);
        if (!photos.isJpeg(buf)) return send(res, 415, { code: 'unsupported-media', error: 'That isn’t a JPEG image.' });
        try {
          const result = await photos.put(id, storeId, who.principal, buf, maxPhotosPerStore);
          return send(res, result === 'created' ? 201 : 200, { ok: true, result });
        } catch (e) {
          if (e instanceof PhotoConflict) return send(res, 409, { code: 'photo-exists', error: e.message });
          if (e instanceof PhotoQuota) return send(res, 413, { code: 'too-many-photos', error: e.message });
          throw e;
        }
      }
      if (req.method === 'GET') {
        const row = photos.row(id);
        // Authorized by the store the photo was uploaded for — never by references in documents.
        if (!row || (who.role !== 'super' && (row.store_id === null || docs.stores[row.store_id]?.adminId !== who.id))) return send(res, 404, { code: 'not-found', error: 'not found' });
        const stream = fs.createReadStream(photos.file(id));
        await new Promise<void>((resolve) => {
          stream.once('open', () => {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(row.size), 'Cache-Control': 'private, max-age=31536000, immutable' });
            stream.pipe(res);
            resolve();
          });
          stream.once('error', (e) => {
            log('error', 'photo-read-failed', { photo: id, ...errorFields(e) });
            if (!res.headersSent) send(res, 404, { code: 'not-found', error: 'not uploaded yet' });
            else res.destroy();
            resolve();
          });
        });
        return true;
      }
    }

    return send(res, 404, { code: 'not-found', error: 'not found' });
  }

  /* ---------- public self check-in ---------- */

  const tooMany = (res: ServerResponse, wait: number) => {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    return send(res, 429, { code: 'rate-limited', error: 'Too many tries — wait a few minutes, or ask at the desk.' });
  };
  const notFound = (res: ServerResponse) => send(res, 404, { code: 'not-found', error: 'This check-in link isn’t valid any more — ask at the desk.' });

  async function publicCheckIn(req: IncomingMessage, res: ServerResponse, token: string) {
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { code: 'bad-request', error: 'GET or POST' });
    const ip = clientIp(req, trustProxy);
    const ipWait = publicLimiter.ipBlockedFor(ip);
    if (ipWait) return tooMany(res, ipWait);
    let store = storeByToken(docs.stores, token);
    if (!store) {
      publicLimiter.attempt(ip, null, true);
      return notFound(res);
    }
    if (req.method === 'GET') {
      const event = docs.events[store.eventId];
      return send(res, 200, { store: store.name, campaign: event?.name ?? '', date: store.date || event?.date || '', open: store.day.selfCheckIn?.open === true });
    }

    const storeWait = publicLimiter.storeBlockedFor(store.id);
    if (storeWait) return tooMany(res, storeWait);
    const body = await readJson(req, 2000);
    store = storeByToken(docs.stores, token); // the body took time: the token may have been rotated meanwhile
    if (!store) {
      publicLimiter.attempt(ip, null, true);
      return notFound(res);
    }
    const at = new Date(now()).toISOString();
    const r = selfCheckIn(store, body?.phone, at);
    publicLimiter.attempt(ip, store.id, r.kind !== 'ok' && r.kind !== 'already' && r.kind !== 'closed');
    if (r.kind === 'closed') return send(res, 403, { code: 'closed', error: 'Check-in isn’t open yet — ask at the desk' });
    if (r.kind === 'bad-phone') return send(res, 400, { code: 'bad-request', error: 'Type the phone number you registered with.' });
    if (r.kind === 'no-match') return send(res, 404, { code: 'no-match', error: 'We couldn’t find that number. Check it, or ask at the desk.' });
    if (r.kind === 'ambiguous') return send(res, 409, { code: 'ambiguous', error: 'ask at the desk' });
    if (r.kind === 'already') return send(res, 200, { ok: true, name: r.name, already: true });

    // Committed exactly like a batch (validated, new seq, broadcast to whoever may see the store).
    const id = `player-${randomBytes(12).toString('base64url')}`;
    const ops = diffDocs({ events: {}, stores: { [store.id]: store }, admins: {} }, { events: {}, stores: { [store.id]: r.next }, admins: {} });
    const { work, touched } = workCopy([['stores', store.id]]);
    work.stores[store.id] = r.next;
    check(work, touched, true);
    const n = commit(id, sha256(canonical({ ops })), work, touched, id, ops);
    log('info', 'self-checkin', { principal: 'player', store: store.id, seq: n });
    return send(res, 200, { ok: true, name: r.name, already: false });
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      try {
        return await handle(req, res);
      } catch (e) {
        const known = e instanceof HttpError;
        const status = known ? e.status : (e as { status?: number }).status ?? 500;
        if (status >= 500) log('error', 'request-failed', { route: `${req.method} ${(req.url ?? '').split('?')[0].slice(0, 200)}`, ...errorFields(e) });
        if (!res.headersSent) {
          if (status === 413) res.setHeader('Connection', 'close');
          send(res, status, known ? { code: e.code, error: e.message, ...e.extra } : { code: status === 413 ? 'too-large' : 'server-error', error: status >= 500 ? 'Server error' : (e as Error).message });
        } else res.destroy();
        return true;
      }
    },
    /** The Toornament auto-check: tick() looks at every store that is due right now (the timer calls it; tests call it with a fake clock). */
    toornamentAuto,
    /** Stops timers, ends event streams, closes the database and releases the data-dir lock. */
    close() {
      toornamentAuto.stop();
      clearInterval(ticker);
      clearInterval(pruner);
      for (const res of streams.keys()) res.end();
      streams.clear();
      try {
        db.close();
      } finally {
        releaseLock();
      }
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) return reject(new HttpError(413, 'too-large', 'Request too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too-large', 'Request too large'));
        req.removeAllListeners('data');
        req.resume();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
