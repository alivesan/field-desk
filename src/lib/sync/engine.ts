/*
 * The sync engine: state + outbox + server sync, with every outside dependency injected
 * (storage, fetch, EventSource, locks, clock) so the same code runs in Node tests.
 * src/lib/db.ts wires it to the browser and keeps the app-facing API.
 *
 *   view = last known server snapshot  +  this device's queued work (in creation order)
 *
 * Work entries ("w:<id>" in the principal's store) — one per document (k,id) or per command:
 *   queued ──freeze──▶ queued+frozen ──POST──▶ sent (sentSeq) ──stream/snapshot ≥ sentSeq──▶ gone
 *                                        └──▶ failed | conflict (kept, with status + reason)
 *   An edit only compacts into the newest *unfrozen* entry of this tab for the same doc, with
 *   no later entry (op or command) for that doc in between. Freezing stores the exact request
 *   body and is awaited before the first network attempt, so every retry — including after a
 *   reload — is byte-identical, and later edits always get a new id (F01).
 *   Failed / conflict entries leave the overlay (the screen shows server truth) but stay
 *   listed until the user retries (new id) or discards them (F09).
 *   Commands are checked against the view when queued: if they don't apply there, they are
 *   recorded as conflict/failed and NOT sent (the user acted on something they can't see).
 *   Once queued, a command is always sent — if later remote changes make it inapplicable on
 *   this device it is only annotated ("note"); the server is the authority.
 *
 * Storage per principal ("super" | "admin:<id>"), F05:
 *   field-desk:<principal>         state  { server: snapshot, w:<id>: entry, u:<photoId>: upload }
 *   field-desk-photos:<principal>  photos { <photoId>: Blob }
 *   localStorage fd-principal / fd-name (last verified identity), fd-epoch (bumped on every
 *   sign-in / sign-out in any tab), fd-legacy-migrated.
 * Identity change: the previous principal's snapshot and cached photos are deleted; its queued
 * work and pending photos stay in its own store, are never sent under anyone else, and resume
 * when it signs in again. Logout wipes the current principal's stores.
 *
 * Generations: every async continuation captures `gen`; identity change, sign-in, sign-out,
 * 401 and stop() bump it, abort in-flight requests and close the stream, so stale responses
 * do nothing. Writes also re-check fd-epoch under a shared "fd-session" lock that sign-in /
 * sign-out take exclusively — another tab switching accounts stops this tab's sends.
 */
import type { AppState, Store } from '../types.ts';
import { applyOps, compactInto, diffDocs, type DocKind, type Docs, type Op } from '../ops.ts';
import { applyCommand, CommandError, type Command, type CommandContext } from '../commands.ts';
import { allPhotoRefs } from '../recce.ts';
import { uid } from '../util.ts';
import type { KV, Locks, Prefs, StorageFactory } from './storage.ts';

export type Role = 'super' | 'admin';
export type Connection = 'connecting' | 'live' | 'offline' | 'locked';
export type SyncStatus = Connection | 'storage-error';

export interface SyncInfo {
  status: SyncStatus; // connection, except 'storage-error' while this device can't save (not when locked)
  connection: Connection;
  pending: number; // queued + sending (edits, commands, photos)
  failed: number; // failed + conflict — the user must act on these
  held: number; // work from before the update, waiting for an explicit decision
  role: Role | null; // null until known
  name?: string;
  error?: string; // why sign-in is needed / failed
  principal?: string | null; // "super" | "admin:<id>"
  lastSyncAt?: string | null; // last snapshot or stream message from the server
  storageError?: string | null; // why this device can't save right now
}

export type WorkReason =
  | 'forbidden' // permission changed / not yours / HQ-only field
  | 'invalid' // server validation
  | 'conflict' // state moved on (commands)
  | 'reused' // server saw this id with different content
  | 'too-large'
  | 'bad-media'
  | 'photo-conflict'
  | 'missing' // photo file no longer on this device
  | 'no-store' // photo from before the update whose store can't be determined
  | 'legacy'; // queued before the update, needs a decision

/** A unit of local work not yet accepted by the server, or rejected by it. */
export interface PendingWork {
  id: string;
  kind: 'ops' | 'cmd' | 'upload';
  storeId?: string;
  cmd?: Command;
  state: 'queued' | 'sending' | 'failed' | 'conflict';
  error?: string; // human-readable reason for failed / conflict
  createdAt: string;
  reason?: WorkReason;
  status?: number; // HTTP status of the rejection
  note?: string; // queued but no longer applies on this device — the server will decide
  held?: boolean; // from before the update: needs "send as me" / export / discard
  saved: boolean; // durably stored on this device
  summary: string; // "Recce · network" / "match.start" / "Photo"
}

export interface EventSourceLike {
  onopen: ((e: any) => void) | null;
  onmessage: ((e: any) => void) | null; // e.data: the JSON message
  onerror: ((e: any) => void) | null;
  readonly readyState: number;
  close(): void;
  addEventListener?(type: string, fn: (e: any) => void): void; // named "ping" heartbeats
}

export interface EngineDeps {
  storage: StorageFactory;
  prefs: Prefs;
  fetch: typeof fetch;
  eventSource: (url: string) => EventSourceLike;
  locks?: Locks;
  base?: string; // URL prefix ('' in the browser)
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  tabId?: string;
  confirm?: (message: string) => boolean;
  download?: (json: string, filename: string) => void;
  warn?: (...args: unknown[]) => void;
}

interface Snapshot extends Docs {
  seq: number;
}
interface StreamMsg {
  seq: number;
  id: string;
  ops: Op[];
  resync?: true;
}

interface Entry {
  v: 1;
  id: string;
  kind: 'ops' | 'cmd';
  tab: string; // tab that owns it — only the owner (or an adopter, once the owner is gone) writes it
  order: string; // sortable creation order
  createdAt: string;
  doc?: { k: DocKind; id: string }; // ops entries: the one document they touch (absent: legacy multi-doc)
  storeId?: string;
  ops?: Op[];
  cmd?: Command;
  body?: string; // frozen request body — set once before the first attempt, never changed
  state: 'queued' | 'failed' | 'conflict';
  reason?: WorkReason;
  status?: number;
  error?: string;
  sentSeq?: number; // server seq once accepted
  held?: 'legacy';
}

interface Upload {
  v: 1;
  id: string; // photo id
  storeId?: string;
  tab: string;
  order: string;
  createdAt: string;
  state: 'queued' | 'failed';
  reason?: WorkReason;
  status?: number;
  error?: string;
  held?: 'legacy';
}

interface Session {
  principal: string;
  role: Role;
  name?: string;
  verified: boolean; // confirmed by /api/me in this generation — nothing is sent before
  epoch: string | null; // fd-epoch when it was verified
  state: KV;
  photos: KV;
}

export const PREF_PRINCIPAL = 'fd-principal';
export const PREF_NAME = 'fd-name';
export const PREF_EPOCH = 'fd-epoch';
export const PREF_LEGACY = 'fd-legacy-migrated';
export const stateDbName = (principal: string) => `field-desk:${principal}`;
export const photoDbName = (principal: string) => `field-desk-photos:${principal}`;

class Stale extends Error {}
class AuthLost extends Error {}
class IdentityChanged extends Error {}
class Transient extends Error {}

const emptySnapshot = (): Snapshot => ({ seq: 0, events: {}, stores: {}, admins: {} });
const roleOf = (principal: string): Role => (principal === 'super' ? 'super' : 'admin');
const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const validSnapshot = (x: unknown): x is Snapshot => isObj(x) && typeof x.seq === 'number' && isObj(x.events) && isObj(x.stores);

export function principalOf(me: { role?: string | null; principal?: unknown; id?: unknown; name?: unknown }) {
  if (typeof me.principal === 'string' && me.principal) return me.principal;
  if (me.role === 'super') return 'super';
  // Older servers don't say which admin; fall back to the name (best effort, still per-person).
  return `admin:${typeof me.id === 'string' ? me.id : `name:${String(me.name ?? '?')}`}`;
}

/** Reason → what the person should understand. */
export function describeFailure(reason: WorkReason | undefined, server?: string) {
  const why = server ? ` (${server})` : '';
  switch (reason) {
    case 'forbidden':
      return `Not accepted: you no longer have access to this store, or this change is HQ-only${why}.`;
    case 'invalid':
      return `Not accepted: the server found this change invalid${why}.`;
    case 'conflict':
      return `Conflict: ${server ?? 'the tournament moved on'} — the screen shows the current state; retry if it still applies.`;
    case 'reused':
      return 'Not accepted: an earlier attempt with different content already reached the server. Check the store, then retry to send this again.';
    case 'too-large':
      return `Not accepted: too large to upload${why}.`;
    case 'bad-media':
      return `Not accepted: not a valid JPEG photo${why}.`;
    case 'photo-conflict':
      return 'Not accepted: a different photo already uses this id on the server.';
    case 'missing':
      return 'The photo file is no longer on this device.';
    case 'no-store':
      return 'Saved before the update, and no store on this device uses it any more, so it can’t be uploaded. Export it if you need it, or discard it.';
    case 'legacy':
      return 'Saved on this device before the update and never confirmed. Send it as you, export it, or discard it.';
    default:
      return server ?? 'Not accepted by the server.';
  }
}

function storageMessage(e: unknown) {
  const name = (e as { name?: string })?.name;
  if (name === 'QuotaExceededError') return 'This device is out of storage space, so changes can’t be saved on it. Keep this page open until they’re sent, or export them.';
  return 'This browser isn’t letting Field Desk save data (private mode or blocked storage). Keep this page open until changes are sent, or export them.';
}

function summarize(e: { kind: 'ops' | 'cmd' | 'upload'; ops?: Op[]; cmd?: Command }) {
  if (e.kind === 'upload') return 'Photo';
  if (e.kind === 'cmd') return e.cmd?.type ?? 'Command';
  const parts = new Set<string>();
  for (const o of e.ops ?? []) {
    const [a, b] = o.p;
    parts.add(!o.p.length ? (o.d ? 'deleted' : 'created') : [a, typeof b === 'string' ? b : ''].filter(Boolean).join(' · '));
  }
  return [...parts].slice(0, 3).join(', ') || 'Edit';
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(deps: EngineDeps) {
  const base = deps.base ?? '';
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const warn = deps.warn ?? ((...a: unknown[]) => console.warn('[sync]', ...a));
  const tabId = deps.tabId ?? uid();
  const prefs = deps.prefs;
  const iso = () => new Date(now()).toISOString();
  let counter = 0;
  const nextOrder = () => `${String(now()).padStart(15, '0')}.${tabId}.${String(++counter).padStart(6, '0')}`;

  /* ---------- state ---------- */

  let gen = 0;
  let session: Session | null = null;
  let server: Snapshot = emptySnapshot();
  let entries: Entry[] = [];
  const uploads = new Map<string, Upload>();
  const memBlobs = new Map<string, Blob>(); // photos this device couldn't store
  const inflight = new Set<string>();
  const notes = new Map<string, string>();
  const aborts = new Set<AbortController>();
  const timers = new Set<unknown>();

  let state: AppState = { version: 1, events: {}, stores: {}, admins: {} };
  let sync: SyncInfo = { status: 'connecting', connection: 'connecting', pending: 0, failed: 0, held: 0, role: null, principal: null, lastSyncAt: null, storageError: null };
  let pendingList: PendingWork[] = [];
  let pendingKey = '';
  let storageError: string | null = null;
  const unsaved = new Set<string>(); // keys whose latest write failed
  const writing = new Map<string, number>();

  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const later = (fn: () => void, ms: number, g?: number) => {
    const t = setT(() => {
      timers.delete(t);
      if (g === undefined || g === gen) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: unknown) => {
    if (t === undefined) return;
    clearT(t);
    timers.delete(t);
  };

  const withLock = <T>(name: string, mode: 'exclusive' | 'shared', fn: () => Promise<T>): Promise<T> => (deps.locks ? deps.locks.request(name, { mode }, fn) : fn());

  async function liveTabs() {
    if (!deps.locks?.query) return new Set([tabId]);
    try {
      const { held = [] } = await deps.locks.query();
      return new Set(held.map((l) => l.name ?? '').filter((n) => n.startsWith('fd-tab-')).map((n) => n.slice(7)));
    } catch {
      return new Set([tabId]);
    }
  }

  /* ---------- derived state ---------- */

  const confirmed = (e: { sentSeq?: number }) => e.sentSeq != null && e.sentSeq <= server.seq;
  const active = (e: Entry) => e.state === 'queued' && !e.held && !confirmed(e);
  const entryKey = (id: string) => `${session?.principal}\u0000w:${id}`;
  const uploadKey = (id: string) => `${session?.principal}\u0000u:${id}`;
  const isSaved = (k: string) => !unsaved.has(k) && !writing.get(k);

  function workList(): PendingWork[] {
    const list: (PendingWork & { order: string })[] = [];
    for (const e of entries) {
      if (e.sentSeq != null) continue; // accepted; stays in the view until the stream / a snapshot catches up
      list.push({
        order: e.order,
        id: e.id,
        kind: e.kind,
        storeId: e.storeId ?? (e.doc?.k === 'stores' ? e.doc.id : undefined),
        cmd: e.cmd,
        state: e.state === 'queued' ? (inflight.has(e.id) ? 'sending' : 'queued') : e.state,
        error: e.error,
        createdAt: e.createdAt,
        reason: e.reason,
        status: e.status,
        note: notes.get(e.id),
        held: !!e.held,
        saved: isSaved(entryKey(e.id)),
        summary: summarize(e),
      });
    }
    for (const u of uploads.values()) {
      list.push({
        order: u.order,
        id: u.id,
        kind: 'upload',
        storeId: u.storeId,
        state: u.state === 'queued' ? (inflight.has(u.id) ? 'sending' : 'queued') : u.state,
        error: u.error,
        createdAt: u.createdAt,
        reason: u.reason,
        status: u.status,
        held: !!u.held,
        saved: isSaved(uploadKey(u.id)) && !memBlobs.has(u.id),
        summary: 'Photo',
      });
    }
    list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    return list.map(({ order: _o, ...w }) => w);
  }

  /** Recomputes pending work + counts; emits if anything visible changed. */
  function changed(force = false) {
    const list = workList();
    const key = JSON.stringify(list);
    let dirty = force;
    if (key !== pendingKey) {
      pendingKey = key;
      pendingList = list;
      dirty = true;
    }
    const pending = list.filter((w) => !w.held && (w.state === 'queued' || w.state === 'sending')).length;
    const failed = list.filter((w) => !w.held && (w.state === 'failed' || w.state === 'conflict')).length;
    const held = list.filter((w) => w.held).length;
    const err = storageError;
    const status: SyncStatus = sync.connection !== 'locked' && err ? 'storage-error' : sync.connection;
    const next = { ...sync, pending, failed, held, status, storageError: err };
    if ((Object.keys(next) as (keyof SyncInfo)[]).some((k) => next[k] !== sync[k])) {
      sync = next;
      dirty = true;
    }
    if (dirty) emit();
  }

  function setSync(patch: Partial<SyncInfo>) {
    sync = { ...sync, ...patch };
    changed(true);
  }
  const setConnection = (connection: Connection) => connection !== sync.connection && setSync({ connection });

  function rebuild() {
    const view: Docs = structuredClone({ events: server.events, stores: server.stores, admins: server.admins ?? {} });
    notes.clear();
    for (const e of entries) {
      if (!active(e)) continue;
      if (e.kind === 'ops') applyOps(view, e.ops ?? []);
      else if (e.cmd && e.storeId) {
        const store = view.stores[e.storeId] as Store | undefined;
        const event = store && view.events[store.eventId];
        if (!store || !event || !session) {
          notes.set(e.id, 'Waiting for the server — this store isn’t loaded on this device.');
          continue;
        }
        try {
          view.stores[e.storeId] = applyCommand(structuredClone(store), e.cmd, cmdContext(e.id, e.createdAt, event));
        } catch (err) {
          notes.set(e.id, `May not apply any more: ${(err as Error).message}. Waiting for the server’s answer.`);
        }
      }
    }
    state = { version: 1, events: view.events, stores: view.stores, admins: view.admins };
    changed(true);
  }

  const cmdContext = (commandId: string, createdAt: string, event: any): CommandContext => ({
    commandId,
    now: createdAt,
    actor: { principal: session!.principal, name: session!.name ?? (session!.role === 'super' ? 'HQ' : ''), role: session!.role },
    event,
  });

  /* ---------- persistence ---------- */

  const chains = new Map<string, Promise<boolean>>();

  function storageFailed(e: unknown) {
    warn('storage write failed', e);
    storageError = storageMessage(e);
  }

  /** Serialised per key, so writes land in call order. Resolves false (and flags the device) on failure. */
  function write(kv: KV, key: string, value: unknown, ck: string): Promise<boolean> {
    writing.set(ck, (writing.get(ck) ?? 0) + 1);
    const run = async () => {
      try {
        if (value === undefined) await kv.del(key);
        else await kv.set(key, value);
        unsaved.delete(ck);
        if (!unsaved.size) storageError = null;
        return true;
      } catch (e) {
        unsaved.add(ck);
        storageFailed(e);
        return false;
      } finally {
        const n = (writing.get(ck) ?? 1) - 1;
        if (n) writing.set(ck, n);
        else writing.delete(ck);
      }
    };
    const p = (chains.get(ck) ?? Promise.resolve(true)).then(run, run);
    chains.set(ck, p);
    void p.then(() => {
      if (chains.get(ck) === p) chains.delete(ck);
      changed();
    });
    changed();
    return p;
  }

  const persistEntry = (e: Entry, s = session) => (s ? write(s.state, `w:${e.id}`, e, `${s.principal}\u0000w:${e.id}`) : Promise.resolve(false));
  const dropEntry = (e: Entry, s = session) => (s ? write(s.state, `w:${e.id}`, undefined, `${s.principal}\u0000w:${e.id}`) : Promise.resolve(false));
  const persistUpload = (u: Upload, s = session) => (s ? write(s.state, `u:${u.id}`, u, `${s.principal}\u0000u:${u.id}`) : Promise.resolve(false));
  const dropUpload = (u: Upload, s = session) => (s ? write(s.state, `u:${u.id}`, undefined, `${s.principal}\u0000u:${u.id}`) : Promise.resolve(false));

  let serverTimer: unknown;
  function saveServerSoon(g: number) {
    cancel(serverTimer);
    const s = session;
    serverTimer = later(
      () => {
        if (s && s === session) void write(s.state, 'server', server, `${s.principal}\u0000server`);
      },
      500,
      g,
    );
  }

  /** Re-tries writes that failed earlier (storage freed up, permission granted…). */
  async function retryUnsaved() {
    const s = session;
    if (!s || !unsaved.size) return;
    for (const e of entries) if (unsaved.has(entryKey(e.id))) await persistEntry(e, s);
    for (const u of uploads.values()) if (unsaved.has(uploadKey(u.id))) await persistUpload(u, s);
    for (const [id, blob] of memBlobs) if (await write(s.photos, id, blob, `${s.principal}\u0000p:${id}`)) memBlobs.delete(id);
    if (unsaved.has(`${s.principal}\u0000server`)) await write(s.state, 'server', server, `${s.principal}\u0000server`);
    // keys of other principals / deleted records can't be retried; forget them
    for (const k of [...unsaved]) if (!k.startsWith(`${s.principal}\u0000`)) unsaved.delete(k);
    if (!unsaved.size) storageError = null;
    changed();
  }

  function openSession(principal: string, role: Role, name: string | undefined, verified: boolean): Session {
    return {
      principal,
      role,
      name,
      verified,
      epoch: null,
      state: deps.storage.open(stateDbName(principal), 'state'),
      photos: deps.storage.open(photoDbName(principal), 'photos'),
    };
  }

  async function readAll(kv: KV) {
    const keys = await kv.keys();
    const values = await kv.getMany(keys);
    return new Map(keys.map((k, i) => [k, values[i]]));
  }

  /** Loads a principal's snapshot + work into memory. Storage failures leave an empty, working app. */
  async function loadNamespace(s: Session, g: number) {
    let all = new Map<string, unknown>();
    try {
      all = await readAll(s.state);
    } catch (e) {
      storageFailed(e);
    }
    if (g !== gen || s !== session) return false;
    const srv = all.get('server');
    server = validSnapshot(srv) ? { ...srv, admins: srv.admins ?? {} } : emptySnapshot();
    entries = [];
    uploads.clear();
    for (const [k, v] of all) {
      if (k.startsWith('w:') && isObj(v) && v.v === 1) entries.push(v as Entry);
      else if (k.startsWith('u:') && isObj(v) && v.v === 1) uploads.set((v as Upload).id, v as Upload);
    }
    entries.sort(byOrder);
    return true;
  }
  const byOrder = (a: { order: string }, b: { order: string }) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);

  /** Picks up what sibling tabs wrote; drops their entries that are gone. Own entries are never dropped. */
  async function reloadFromStorage(s: Session, g: number) {
    let all: Map<string, unknown>;
    try {
      all = await readAll(s.state);
    } catch {
      return;
    }
    if (g !== gen) return;
    const live = await liveTabs();
    const stored = new Map<string, Entry>();
    for (const [k, v] of all) if (k.startsWith('w:') && isObj(v) && v.v === 1) stored.set((v as Entry).id, v as Entry);
    const next: Entry[] = [];
    for (const e of entries) {
      const st = stored.get(e.id);
      stored.delete(e.id);
      if (e.tab === tabId) next.push(e);
      else if (st) next.push({ ...st, sentSeq: st.sentSeq ?? e.sentSeq });
    }
    for (const st of stored.values()) {
      if (confirmed(st)) {
        if (!live.has(st.tab)) void dropEntry(st, s); // its tab is gone: tidy up
        continue;
      }
      next.push(st);
    }
    entries = next.sort(byOrder);
    const storedUp = new Set<string>();
    for (const [k, v] of all) {
      if (!k.startsWith('u:') || !isObj(v) || v.v !== 1) continue;
      const u = v as Upload;
      storedUp.add(u.id);
      const mine = uploads.get(u.id);
      if (!mine || mine.tab !== tabId) uploads.set(u.id, u);
    }
    for (const [id, u] of uploads) if (!storedUp.has(id) && u.tab !== tabId) uploads.delete(id);
    rebuild();
  }

  /** The previous principal's readable copy: snapshot and cached photos. Its queued work stays. */
  async function wipeReadable(principal: string) {
    const st = deps.storage.open(stateDbName(principal), 'state');
    const ph = deps.storage.open(photoDbName(principal), 'photos');
    try {
      await st.del('server');
      const keep = new Set((await st.keys()).filter((k) => k.startsWith('u:')).map((k) => k.slice(2)));
      for (const k of await ph.keys()) if (!keep.has(k)) await ph.del(k);
    } catch (e) {
      storageFailed(e);
    }
  }

  /* ---------- network ---------- */

  function bumpGen() {
    gen++;
    for (const a of aborts) a.abort();
    aborts.clear();
    inflight.clear();
    closeStream();
    for (const t of [...timers]) cancel(t);
    serverTimer = undefined;
    flushTimer = undefined;
    tickTimer = undefined;
    resyncing = null;
    buffer = null;
    if (session) session.verified = false;
    startTick();
  }

  /** fetch bound to a generation + verified identity; aborted when the generation ends. */
  async function request(g: number, path: string, init: RequestInit, ms: number): Promise<Response> {
    if (g !== gen) throw new Stale();
    return withLock('fd-session', 'shared', async () => {
      const s = session;
      if (g !== gen || !s?.verified) throw new Stale();
      if (s.epoch !== prefs.get(PREF_EPOCH)) throw new IdentityChanged();
      const ctrl = new AbortController();
      aborts.add(ctrl);
      const t = setT(() => ctrl.abort(), ms);
      try {
        const headers = new Headers(init.headers);
        headers.set('X-Field-Desk-Principal', s.principal);
        return await deps.fetch(base + path, { ...init, headers, signal: ctrl.signal, cache: 'no-store' });
      } catch (e) {
        if (g !== gen) throw new Stale();
        throw new Transient((e as Error).message);
      } finally {
        clearT(t);
        aborts.delete(ctrl);
      }
    });
  }

  /** Plain fetch with a timeout, for sign-in / identity checks. */
  async function rawFetch(path: string, init: RequestInit, ms: number) {
    const ctrl = new AbortController();
    const t = setT(() => ctrl.abort(), ms);
    try {
      return await deps.fetch(base + path, { ...init, signal: ctrl.signal, cache: 'no-store' });
    } finally {
      clearT(t);
    }
  }

  const readJson = async (r: Response) => {
    try {
      return (await r.json()) as Record<string, any> | null;
    } catch {
      return null;
    }
  };

  /** HTTP outcome → what to do. Throws for auth / transient; returns a failure for rejections. */
  function classify(status: number, body: Record<string, any> | null, kind: 'ops' | 'cmd' | 'upload'): { state: 'failed' | 'conflict'; reason: WorkReason; server?: string } | null {
    if (status >= 200 && status < 300) return null;
    if (status === 401) throw new AuthLost();
    if (status === 409 && body?.code === 'principal-mismatch') throw new IdentityChanged();
    if (status >= 500 || status === 408 || status === 425 || status === 429 || status === 0) throw new Transient(`HTTP ${status}`);
    const serverMsg = typeof body?.error === 'string' ? body.error : undefined;
    if (status === 403) return { state: 'failed', reason: 'forbidden', server: serverMsg };
    if (status === 413) return { state: 'failed', reason: 'too-large', server: serverMsg };
    if (kind === 'upload') {
      if (status === 409) return { state: 'failed', reason: 'photo-conflict', server: serverMsg };
      if (status === 415 || body?.code === 'unsupported-media') return { state: 'failed', reason: 'bad-media', server: serverMsg };
      return { state: 'failed', reason: 'invalid', server: serverMsg };
    }
    if (status === 409) {
      if (body?.code === 'batch-id-reused') return { state: 'failed', reason: 'reused', server: serverMsg };
      return { state: 'conflict', reason: 'conflict', server: serverMsg };
    }
    return { state: 'failed', reason: 'invalid', server: serverMsg };
  }

  /* ---------- sending ---------- */

  let flushTimer: unknown;
  let flushing = false;
  let flushAgain = false;
  let backoff = 0;

  function scheduleFlush(ms = 350) {
    cancel(flushTimer);
    flushTimer = later(() => void flush(), ms);
  }

  const sendable = (e: Entry, live: Set<string>) => e.state === 'queued' && !e.held && e.sentSeq == null && (e.tab === tabId || !live.has(e.tab));
  const queuedUploads = () => [...uploads.values()].filter((u) => u.state === 'queued' && !u.held).sort(byOrder);

  async function flush(): Promise<void> {
    const s = session;
    if (!s?.verified) return;
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    const g = gen;
    try {
      await withLock(`fd-flush:${s.principal}`, 'exclusive', async () => {
        if (g !== gen) return;
        await reloadFromStorage(s, g);
        await retryUnsaved();
        const live = await liveTabs();
        for (const e of [...entries]) {
          if (g !== gen) return;
          if (!sendable(e, live)) continue;
          if (e.tab !== tabId) {
            e.tab = tabId; // adopt: its tab is gone
            await persistEntry(e, s);
          }
          // photos this entry references go first (the server refuses references to unknown photos)
          const text = e.body ?? JSON.stringify(e.ops ?? e.cmd ?? null);
          for (const u of queuedUploads()) if (text.includes(`"${u.id}"`)) await upload(g, s, u);
          await sendEntry(g, s, e);
        }
        for (const u of queuedUploads()) await upload(g, s, u);
      });
      if (g !== gen) return;
      backoff = 0;
      prune();
      rebuild();
      if (streamLive) setConnection('live');
    } catch (err) {
      if (g !== gen || err instanceof Stale) return;
      if (err instanceof AuthLost) return void authLost();
      if (err instanceof IdentityChanged) return void connect();
      warn('send failed, will retry', (err as Error).message);
      setConnection('offline');
      backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
      scheduleFlush(backoff + Math.round(Math.random() * 500));
      rebuild();
    } finally {
      flushing = false;
      if (flushAgain) {
        flushAgain = false;
        scheduleFlush(50); // asked for while this one ran (maybe in a newer generation)
      }
    }
  }

  async function sendEntry(g: number, s: Session, e: Entry) {
    if (!e.body) {
      // Freeze: from here on this exact body is what gets sent, every time.
      e.body = e.kind === 'cmd' ? JSON.stringify({ id: e.id, storeId: e.storeId, cmd: e.cmd }) : JSON.stringify({ id: e.id, ops: e.ops });
      const saved = await persistEntry(e, s);
      if (!saved) warn('could not store frozen batch before sending; sending from memory', e.id);
      if (g !== gen) throw new Stale();
    }
    inflight.add(e.id);
    changed();
    try {
      const r = await request(g, e.kind === 'cmd' ? '/api/command' : '/api/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: e.body }, 30000);
      const body = await readJson(r);
      if (g !== gen) throw new Stale();
      const fail = classify(r.status, body, e.kind);
      if (!fail) {
        if (!r.ok || body === null) throw new Transient('unreadable response');
        e.sentSeq = typeof body.seq === 'number' ? body.seq : 0;
      } else {
        e.state = fail.state;
        e.reason = fail.reason;
        e.status = r.status;
        e.error = describeFailure(fail.reason, fail.server);
        warn('work rejected', e.id, r.status, fail.server);
      }
      await persistEntry(e, s);
      rebuild();
    } finally {
      inflight.delete(e.id);
      changed();
    }
  }

  async function upload(g: number, s: Session, u: Upload) {
    if (u.state !== 'queued' || !uploads.has(u.id)) return;
    let blob: Blob | undefined = memBlobs.get(u.id);
    if (!blob) {
      try {
        blob = (await s.photos.get<Blob>(u.id)) ?? undefined;
      } catch (e) {
        storageFailed(e);
        throw new Transient('photo unreadable');
      }
    }
    if (g !== gen) throw new Stale();
    if (!blob || !u.storeId) {
      // never sent without its store (the server files every photo under one)
      const reason: WorkReason = blob ? 'no-store' : 'missing';
      Object.assign(u, { state: 'failed', reason, error: describeFailure(reason) });
      await persistUpload(u, s);
      return;
    }
    inflight.add(u.id);
    changed();
    try {
      const q = u.storeId ? `?store=${encodeURIComponent(u.storeId)}` : '';
      const r = await request(g, `/api/photos/${encodeURIComponent(u.id)}${q}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob }, 180000);
      const body = r.ok ? null : await readJson(r);
      if (g !== gen) throw new Stale();
      const fail = classify(r.status, body, 'upload');
      if (!fail) {
        uploads.delete(u.id);
        await dropUpload(u, s);
        if (memBlobs.has(u.id) && (await write(s.photos, u.id, blob, `${s.principal}\u0000p:${u.id}`))) memBlobs.delete(u.id);
      } else {
        Object.assign(u, { state: 'failed', reason: fail.reason, status: r.status, error: describeFailure(fail.reason, fail.server) });
        warn('photo rejected', u.id, r.status, fail.server);
        await persistUpload(u, s); // kept, with its photo, until the user decides
      }
    } finally {
      inflight.delete(u.id);
      changed();
    }
  }

  function prune() {
    const keep: Entry[] = [];
    for (const e of entries) {
      if (!confirmed(e)) keep.push(e);
      else if (e.tab === tabId) void dropEntry(e);
    }
    if (keep.length !== entries.length) entries = keep;
  }

  /* ---------- receiving ---------- */

  let es: EventSourceLike | null = null;
  let streamLive = false;
  let buffer: StreamMsg[] | null = null;
  let resyncing: Promise<void> | null = null;
  let resyncAgain = false;

  function closeStream() {
    if (!es) return;
    es.onopen = es.onmessage = es.onerror = null;
    es.close();
    es = null;
    streamLive = false;
  }

  async function fetchSnapshot(g: number): Promise<Snapshot> {
    const r = await request(g, '/api/state', { method: 'GET' }, 30000);
    if (r.status === 401) throw new AuthLost();
    if (!r.ok) throw new Transient(`state ${r.status}`);
    const snap = await readJson(r);
    if (g !== gen) throw new Stale();
    if (!validSnapshot(snap)) throw new Transient('bad snapshot');
    const who = (snap as { principal?: unknown }).principal;
    if (typeof who === 'string' && who !== session?.principal) throw new IdentityChanged();
    return { seq: snap.seq, events: snap.events, stores: snap.stores, admins: snap.admins ?? {} };
  }

  /** false = gap in the sequence or a structural change: refetch the snapshot. */
  function applyRemote(m: StreamMsg) {
    const mine = entries.find((e) => e.id === m.id);
    if (mine && mine.sentSeq == null) mine.sentSeq = m.seq; // committed, even if our response was lost
    if (m.resync && !m.id) return false; // the server is closing this stream (session ended): re-check now
    if (m.seq <= server.seq) return true;
    if (m.seq !== server.seq + 1 || m.resync) return false;
    try {
      applyOps(server, Array.isArray(m.ops) ? m.ops : []);
    } catch {
      return false;
    }
    server.seq = m.seq;
    return true;
  }

  /** Single-flight, serialized: fetch a snapshot, replay what arrived meanwhile, repeat until clean. */
  function resync(g: number): Promise<void> {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        resyncAgain = false;
        buffer = [];
        let snap: Snapshot;
        try {
          snap = await fetchSnapshot(g);
        } catch (err) {
          if (g !== gen || err instanceof Stale) return;
          buffer = null;
          streamLive = false;
          if (err instanceof AuthLost) return void authLost();
          if (err instanceof IdentityChanged) return void connect();
          setConnection('offline');
          later(() => void resync(g), 5000, g);
          return;
        }
        server = snap;
        heard();
        const drained = buffer.every((m) => applyRemote(m));
        if (drained && !resyncAgain) break;
        if (attempt >= 4) {
          // keeps changing under us — back off, show what we have, try again shortly
          buffer = null;
          streamLive = false;
          prune();
          rebuild();
          setConnection('offline');
          later(() => void resync(g), 3000, g);
          return;
        }
      }
      buffer = null;
      streamLive = true;
      prune();
      rebuild();
      saveServerSoon(g);
      setConnection('live');
      void flush();
    })();
    resyncing = run.finally(() => {
      if (resyncing === wrapped) resyncing = null;
    });
    const wrapped = resyncing;
    return wrapped;
  }

  let lastHeard = 0;
  const heard = () => {
    lastHeard = now();
    sync = { ...sync, lastSyncAt: iso() };
  };

  /**
   * Freshness while the stream is quiet. EventSource hides ": ping" comments, so: a named
   * `event: ping` (data = server seq) is used when the server sends one; otherwise, after 25 s
   * of silence, a tiny /api/me confirms the server is reachable and still knows us (and its
   * seq, when it reports one, reveals a missed message).
   */
  function watchFreshness(g: number) {
    later(
      async () => {
        if (streamLive && es?.readyState === 1 && now() - lastHeard >= 25000) {
          try {
            const r = await rawFetch('/api/me', { method: 'GET' }, 10000);
            const me = r.ok ? await readJson(r) : null;
            if (g !== gen) return;
            if (me && (!me.role || principalOf(me) !== session?.principal)) return void connect();
            if (me) {
              heard();
              if (typeof me.seq === 'number' && me.seq > server.seq && !buffer) void resync(g);
              changed(true);
            }
          } catch {
            /* the stream's own error handling covers real outages */
          }
        }
        if (g === gen) watchFreshness(g);
      },
      10000,
      g,
    );
  }

  function openStream(g: number) {
    closeStream();
    const s = deps.eventSource(`${base}/api/stream`);
    es = s;
    lastHeard = now();
    watchFreshness(g);
    s.addEventListener?.('ping', (ev) => {
      if (g !== gen || es !== s) return;
      heard();
      const seq = Number(ev?.data);
      if (Number.isFinite(seq) && seq > server.seq && !buffer && streamLive) void resync(g);
      changed(true);
    });
    s.onopen = () => {
      if (g !== gen) return s.close();
      void resync(g);
    };
    s.onmessage = (ev) => {
      if (g !== gen) return s.close();
      let m: StreamMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isObj(m) || typeof m.seq !== 'number') return;
      heard();
      if (buffer) return void buffer.push(m);
      if (!applyRemote(m)) return void resync(g);
      prune();
      rebuild();
      saveServerSoon(g);
    };
    s.onerror = () => {
      if (g !== gen) return;
      streamLive = false;
      setConnection('offline');
      if (s.readyState === 2) {
        if (es === s) es = null;
        later(() => void connect(), 5000, g); // closed for good (e.g. signed out): re-check who we are
      }
    };
  }

  /* ---------- identity ---------- */

  let connectSeq = 0;

  async function connect(): Promise<void> {
    const my = ++connectSeq;
    const epochBefore = prefs.get(PREF_EPOCH);
    let me: Record<string, any> | null;
    try {
      const r = await rawFetch('/api/me', { method: 'GET' }, 15000);
      if (!r.ok) throw new Error(`me ${r.status}`);
      me = await readJson(r);
      if (!me) throw new Error('bad /api/me');
    } catch {
      if (my !== connectSeq) return;
      setConnection(session ? 'offline' : sync.connection === 'locked' ? 'locked' : 'offline');
      later(() => my === connectSeq && void connect(), 5000);
      return;
    }
    if (my !== connectSeq) return;
    if (!me.role) return signedOut();
    const principal = principalOf(me);
    const role: Role = me.role === 'super' ? 'super' : 'admin';
    const name = typeof me.name === 'string' ? me.name : undefined;
    if (!session || session.principal !== principal) {
      if (!(await switchTo(principal, role, name)) || my !== connectSeq) return;
    } else {
      bumpGen(); // fresh generation for the fresh connection
    }
    const s = session!;
    s.role = role;
    s.name = name;
    s.verified = true;
    s.epoch = epochBefore;
    prefs.set(PREF_PRINCIPAL, principal);
    if (name) prefs.set(PREF_NAME, name);
    else prefs.remove(PREF_NAME);
    setSync({ role, name, principal, connection: sync.connection === 'locked' ? 'connecting' : sync.connection });
    const g = gen;
    await migrateLegacy(s, g);
    if (g !== gen) return;
    openStream(g);
    void flush();
  }

  /** Moves this tab to another principal's namespace. */
  async function switchTo(principal: string, role: Role, name: string | undefined) {
    bumpGen();
    const prev = session?.principal ?? prefs.get(PREF_PRINCIPAL); // also when a link sign-in skipped loading it
    session = openSession(principal, role, name, false);
    server = emptySnapshot();
    entries = [];
    uploads.clear();
    memBlobs.clear();
    rebuild();
    setSync({ role, name, principal, connection: 'connecting', lastSyncAt: null });
    const g = gen;
    if (prev && prev !== principal) await wipeReadable(prev);
    if (g !== gen) return false;
    if (!(await loadNamespace(session, g))) return false;
    rebuild();
    return true;
  }

  /** Signed out or revoked: drop the readable copy; queued work stays for this principal's next sign-in. */
  async function signedOut(message?: string) {
    const s = session;
    const unsent = sync.pending + sync.failed;
    bumpGen();
    session = null;
    server = emptySnapshot();
    entries = [];
    uploads.clear();
    memBlobs.clear();
    rebuild();
    const error =
      message ?? (s && unsent ? `You’re signed out. ${unsent} unsent change${unsent > 1 ? 's are' : ' is'} kept on this device and will be sent after you sign in again as the same person.` : sync.error);
    setSync({ connection: 'locked', role: null, name: undefined, principal: null, error });
    const prev = s?.principal ?? prefs.get(PREF_PRINCIPAL);
    prefs.remove(PREF_PRINCIPAL);
    prefs.remove(PREF_NAME);
    if (prev) await wipeReadable(prev);
  }

  function authLost() {
    bumpGen();
    void connect();
  }

  const bumpEpoch = () => prefs.set(PREF_EPOCH, `${now()}.${tabId}.${Math.random().toString(36).slice(2, 8)}`);

  async function login(code: string): Promise<string | null> {
    bumpGen();
    let r: Response;
    try {
      r = await withLock('fd-session', 'exclusive', async () => {
        const res = await rawFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }, 20000);
        if (res.ok) bumpEpoch();
        return res;
      });
    } catch {
      void connect();
      return 'No connection to the server.';
    }
    if (!r.ok) {
      const msg = (await readJson(r))?.error;
      void connect();
      return typeof msg === 'string' ? msg : 'Couldn’t sign in.';
    }
    sync = { ...sync, error: undefined };
    setConnection('connecting');
    void connect();
    return null;
  }

  /** Signs out and wipes this principal's data on this device. Asks first (and exports) if work would be lost. */
  async function logout(): Promise<boolean> {
    const unsent = sync.pending + sync.failed + sync.held;
    if (unsent) {
      const ok = (deps.confirm ?? (() => true))(
        `${unsent} change${unsent > 1 ? 's haven’t' : ' hasn’t'} reached the server and will be deleted from this device.\n\nOK: download a copy and sign out.\nCancel: stay signed in.`,
      );
      if (!ok) return false;
      await exportWork();
    }
    const s = session;
    bumpGen();
    session = null;
    try {
      await withLock('fd-session', 'exclusive', async () => {
        await rawFetch('/api/logout', { method: 'POST' }, 10000).catch(() => null);
        bumpEpoch();
      });
    } catch {
      /* signed out locally regardless */
    }
    if (s) {
      try {
        await Promise.all([s.state.clear(), s.photos.clear()]);
      } catch (e) {
        storageFailed(e);
      }
    }
    server = emptySnapshot();
    entries = [];
    uploads.clear();
    memBlobs.clear();
    unsaved.clear();
    storageError = null;
    prefs.remove(PREF_PRINCIPAL);
    prefs.remove(PREF_NAME);
    rebuild();
    setSync({ connection: 'locked', role: null, name: undefined, principal: null, error: undefined });
    return true;
  }

  /* ---------- legacy (unscoped) storage from the previous version ---------- */

  async function migrateLegacy(s: Session, g: number) {
    if (prefs.get(PREF_LEGACY)) return;
    const L = deps.storage.open('field-desk', 'state');
    const LP = deps.storage.open('field-desk-photos', 'photos');
    let all: Map<string, unknown>;
    try {
      all = await readAll(L);
    } catch {
      return; // try again next time
    }
    if (g !== gen) return;
    if (!all.size) {
      prefs.set(PREF_LEGACY, '1');
      return;
    }
    const srv = all.get('server') as Snapshot | undefined;
    const app = all.get('app') as Docs & { version?: number } | undefined;
    const outbox = (Array.isArray(all.get('outbox')) ? all.get('outbox') : []) as { id?: string; ops?: Op[]; sentSeq?: number }[];
    const upIds = ((Array.isArray(all.get('uploads')) ? all.get('uploads') : []) as unknown[]).filter((x): x is string => typeof x === 'string');

    const batches = outbox.filter((b) => typeof b.id === 'string' && !b.sentSeq && Array.isArray(b.ops) && b.ops.length) as { id: string; ops: Op[] }[];
    if (app?.version === 1 && !srv) {
      const ops = diffDocs({ events: {}, stores: {}, admins: {} }, { events: app.events ?? {}, stores: app.stores ?? {}, admins: app.admins ?? {} });
      if (ops.length) batches.push({ id: 'legacy-local-data', ops });
    }
    const photoStore = new Map<string, string>();
    for (const docs of [srv, app, server]) for (const st of Object.values((docs?.stores ?? {}) as Record<string, Store>)) for (const p of allPhotoRefs(st)) photoStore.set(p.id, st.id);
    for (const b of batches) for (const o of b.ops) if (o.k === 'stores') for (const id of upIds) if (!photoStore.has(id) && JSON.stringify(o).includes(`"${id}"`)) photoStore.set(id, o.id);

    const createdAt = iso();
    let ok = true;
    for (const b of batches) {
      const docs = [...new Set(b.ops.map((o) => `${o.k}\u0000${o.id}`))];
      const firstStore = b.ops.find((o) => o.k === 'stores')?.id;
      const e: Entry = {
        v: 1,
        id: b.id,
        kind: 'ops',
        tab: tabId,
        order: nextOrder(),
        createdAt,
        doc: docs.length === 1 ? { k: b.ops[0].k, id: b.ops[0].id } : undefined,
        storeId: firstStore,
        ops: b.ops,
        body: JSON.stringify({ id: b.id, ops: b.ops }), // exactly what the old version sent, so the server can dedupe it
        state: 'queued',
        reason: 'legacy',
        error: describeFailure('legacy'),
        held: 'legacy',
      };
      if (!entries.some((x) => x.id === e.id)) entries.push(e);
      ok = (await persistEntry(e, s)) && ok;
    }
    for (const id of upIds) {
      let blob: unknown;
      try {
        blob = await LP.get(id);
      } catch {
        ok = false;
        continue;
      }
      if (!blob) continue;
      ok = (await write(s.photos, id, blob, `${s.principal}\u0000p:${id}`)) && ok;
      const storeId = photoStore.get(id);
      const u: Upload = storeId
        ? { v: 1, id, storeId, tab: tabId, order: nextOrder(), createdAt, state: 'queued', reason: 'legacy', error: describeFailure('legacy'), held: 'legacy' }
        : { v: 1, id, tab: tabId, order: nextOrder(), createdAt, state: 'failed', reason: 'no-store', error: describeFailure('no-store'), held: 'legacy' };
      uploads.set(id, u);
      ok = (await persistUpload(u, s)) && ok;
    }
    if (g !== gen) return;
    if (ok) {
      try {
        await Promise.all([L.clear(), LP.clear()]); // the legacy snapshot (readable copy) goes too
        prefs.set(PREF_LEGACY, '1');
      } catch (e) {
        storageFailed(e);
      }
    }
    entries.sort(byOrder);
    rebuild();
  }

  /* ---------- public: state ---------- */

  function update(fn: (draft: AppState) => void) {
    const next = structuredClone(state);
    fn(next);
    const ops = diffDocs(state, next);
    state = { ...next, version: 1 };
    if (!ops.length) return emit();
    const s = session;
    if (!s) {
      warn('edit while signed out — not kept');
      return emit();
    }
    // one entry per document: the authorization boundary on the server
    const groups = new Map<string, Op[]>();
    for (const o of ops) {
      const k = `${o.k}\u0000${o.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(o);
    }
    for (const group of groups.values()) {
      const doc = { k: group[0].k, id: group[0].id };
      const target = compactTarget(doc);
      if (target) {
        compactInto(target.ops!, group);
        void persistEntry(target, s);
      } else {
        const e: Entry = { v: 1, id: uid(), kind: 'ops', tab: tabId, order: nextOrder(), createdAt: iso(), doc, storeId: doc.k === 'stores' ? doc.id : undefined, ops: group, state: 'queued' };
        entries.push(e);
        void persistEntry(e, s);
      }
    }
    changed(true);
    scheduleFlush();
  }

  /** The newest unfrozen entry of this tab for this doc — if nothing for the doc came after it. */
  function compactTarget(doc: { k: DocKind; id: string }) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (confirmed(e)) continue;
      const same = (e.kind === 'ops' && e.doc?.k === doc.k && e.doc.id === doc.id) || (e.kind === 'cmd' && doc.k === 'stores' && e.storeId === doc.id) || (!e.doc && e.kind === 'ops');
      if (!same) continue;
      return e.kind === 'ops' && e.doc && e.tab === tabId && !e.body && e.state === 'queued' && !e.held && !inflight.has(e.id) ? e : null;
    }
    return null;
  }

  function sendCommand(storeId: string, cmd: Command): string {
    const s = session;
    if (!s) throw new Error('Not signed in.');
    const createdAt = iso();
    const e: Entry = { v: 1, id: uid(), kind: 'cmd', tab: tabId, order: nextOrder(), createdAt, storeId, cmd, state: 'queued' };
    const store = state.stores[storeId];
    const event = store && state.events[store.eventId];
    if (store && event) {
      try {
        applyCommand(structuredClone(store), cmd, cmdContext(e.id, createdAt, event));
      } catch (err) {
        if (err instanceof CommandError) {
          // doesn't apply to what this person sees: record it, don't send it
          e.state = err.code === 'conflict' ? 'conflict' : 'failed';
          e.reason = err.code;
          e.error = err.code === 'conflict' ? describeFailure('conflict', err.message) : err.message;
        } else warn('command failed locally; sending anyway', err);
      }
    }
    entries.push(e);
    void persistEntry(e, s);
    rebuild();
    if (e.state === 'queued') scheduleFlush(50);
    return e.id;
  }

  /** Failed / conflict → the same ops or command again under a new id. Held → released as is. Upload → queued again. */
  function retryWork(id: string) {
    const s = session;
    if (!s) return;
    const u = uploads.get(id);
    if (u && (u.state === 'failed' || u.held)) {
      Object.assign(u, { state: 'queued', reason: undefined, status: undefined, error: undefined, held: undefined });
      void persistUpload(u, s);
      changed(true);
      return scheduleFlush(50);
    }
    const e = entries.find((x) => x.id === id);
    if (!e || e.sentSeq != null) return;
    if (e.held && e.state === 'queued') {
      e.held = undefined;
      e.reason = undefined;
      e.error = undefined;
      e.tab = tabId;
      void persistEntry(e, s);
      rebuild();
      return scheduleFlush(50);
    }
    if (e.state === 'queued') return;
    const copy: Entry = { v: 1, id: uid(), kind: e.kind, tab: tabId, order: nextOrder(), createdAt: iso(), doc: e.doc, storeId: e.storeId, ops: e.ops, cmd: e.cmd, state: 'queued' };
    entries = entries.filter((x) => x !== e);
    entries.push(copy);
    void dropEntry(e, s);
    void persistEntry(copy, s);
    rebuild();
    scheduleFlush(50);
  }

  /** "Send as me" for everything held from before the update. */
  function sendHeldWork() {
    for (const w of pendingList) if (w.held) retryWork(w.id);
  }

  function discardWork(id: string) {
    const s = session;
    if (!s) return;
    const u = uploads.get(id);
    if (u && !inflight.has(id)) {
      uploads.delete(id);
      memBlobs.delete(id);
      void dropUpload(u, s);
      void write(s.photos, id, undefined, `${s.principal}\u0000p:${id}`);
      return changed(true);
    }
    const e = entries.find((x) => x.id === id);
    if (!e || inflight.has(id)) return;
    entries = entries.filter((x) => x !== e);
    void dropEntry(e, s);
    rebuild();
  }

  /** Everything unsent (incl. photos) as one JSON document; downloads it when a downloader is wired. */
  async function exportWork() {
    const s = session;
    const photos: { id: string; storeId?: string; state: string; error?: string; jpegBase64?: string }[] = [];
    for (const u of uploads.values()) {
      let blob: Blob | undefined = memBlobs.get(u.id);
      if (!blob && s) {
        try {
          blob = (await s.photos.get<Blob>(u.id)) ?? undefined;
        } catch {
          /* listed without the image */
        }
      }
      photos.push({ id: u.id, storeId: u.storeId, state: u.state, error: u.error, jpegBase64: blob ? await blobToBase64(blob) : undefined });
    }
    const doc = {
      kind: 'field-desk-unsent-work',
      version: 1,
      exportedAt: iso(),
      principal: s?.principal ?? null,
      name: s?.name ?? null,
      work: entries
        .filter((e) => !confirmed(e))
        .map((e) => ({ id: e.id, kind: e.kind, state: e.state, held: !!e.held, reason: e.reason, error: e.error, createdAt: e.createdAt, storeId: e.storeId, doc: e.doc, ops: e.ops, cmd: e.cmd })),
      photos,
    };
    const json = JSON.stringify(doc, null, 1);
    deps.download?.(json, `field-desk-unsent-${iso().slice(0, 10)}.json`);
    return doc;
  }

  /* ---------- public: photos ---------- */

  async function savePhoto(id: string, blob: Blob, storeId: string) {
    const s = session;
    if (!s) throw new Error('Not signed in.');
    if (!(await write(s.photos, id, blob, `${s.principal}\u0000p:${id}`))) memBlobs.set(id, blob); // still uploads while this page is open
    const u: Upload = { v: 1, id, storeId, tab: tabId, order: nextOrder(), createdAt: iso(), state: 'queued' };
    if (s !== session) return;
    uploads.set(id, u);
    await persistUpload(u, s);
    changed(true);
    scheduleFlush();
  }

  async function deletePhoto(id: string) {
    const s = session;
    memBlobs.delete(id);
    const u = uploads.get(id);
    if (u && !inflight.has(id) && s) {
      uploads.delete(id);
      void dropUpload(u, s);
      changed(true);
    }
    if (s) await write(s.photos, id, undefined, `${s.principal}\u0000p:${id}`);
  }

  /** Local copies first; anything missing is fetched from the server and cached for this principal. */
  async function getPhotos(ids: string[]) {
    const s = session;
    const g = gen;
    const out: Record<string, Blob | undefined> = {};
    let local: unknown[] = [];
    if (s) {
      try {
        local = await s.photos.getMany(ids);
      } catch {
        local = [];
      }
    }
    await Promise.all(
      ids.map(async (id, i) => {
        let b = memBlobs.get(id) ?? (local[i] as Blob | undefined);
        if (!b && s?.verified && g === gen) {
          try {
            const r = await request(g, `/api/photos/${encodeURIComponent(id)}`, { method: 'GET' }, 60000);
            if (r.ok && g === gen) {
              b = await r.blob();
              if (g === gen && s === session) void write(s.photos, id, b, `${s.principal}\u0000p:${id}`);
            }
          } catch {
            /* offline, or the session changed — try again later */
          }
        }
        out[id] = g === gen ? b : undefined;
      }),
    );
    return out;
  }

  /* ---------- lifecycle ---------- */

  let tickTimer: unknown;
  function startTick() {
    cancel(tickTimer);
    tickTimer = later(() => {
      if (sync.pending && !flushing) void flush();
      startTick();
    }, 15000);
  }

  let releaseTab: (() => void) | null = null;

  /** Boot. `code` comes from a personal link: sign in with it before showing anything cached. */
  async function start(code?: string) {
    if (deps.locks) void deps.locks.request(`fd-tab-${tabId}`, {}, () => new Promise<void>((r) => (releaseTab = r))).catch(() => {});
    startTick();
    prefs.remove('fd-role'); // the previous version remembered only a role
    const cached = prefs.get(PREF_PRINCIPAL);
    if (cached && !code) {
      // Show the last verified principal's copy while we confirm who this is; nothing is sent until then.
      session = openSession(cached, roleOf(cached), prefs.get(PREF_NAME) ?? undefined, false);
      await loadNamespace(session, gen);
      rebuild();
      setSync({ role: roleOf(cached), name: session.name, principal: cached, connection: 'connecting' });
    }
    if (code) {
      const error = await login(code);
      if (error) setSync({ error });
    } else void connect();
  }

  /** Network came back / tab became visible. */
  function nudge() {
    if (session?.verified && streamLive) void flush();
    else void connect();
  }

  function stop() {
    connectSeq++;
    bumpGen();
    for (const t of [...timers]) cancel(t);
    releaseTab?.();
  }

  return {
    start,
    stop,
    connect,
    login,
    logout,
    nudge,
    flush,
    update,
    sendCommand,
    retryWork,
    discardWork,
    sendHeldWork,
    exportWork,
    savePhoto,
    deletePhoto,
    getPhotos,
    getState: () => state,
    getSync: () => sync,
    getPending: () => pendingList,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** For tests / diagnostics. */
    debug: () => ({ gen, tabId, principal: session?.principal ?? null, verified: !!session?.verified, serverSeq: server.seq, entries: entries.map((e) => ({ ...e })), uploads: [...uploads.values()], streamLive }),
  };
}
