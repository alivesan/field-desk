import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AppState, Laptop, Recce, Store, TournamentEvent } from './types.ts';
import type { Command } from './commands.ts';
import { downloadBlob, todayLocal, uid } from './util.ts';
import { createEngine, type Engine, type EngineDeps } from './sync/engine.ts';
import { idbStorage } from './sync/idb.ts';
import { safePrefs } from './sync/storage.ts';

/*
 * State + sync with the Field Desk server — the app-facing API. The machinery lives in
 * src/lib/sync/engine.ts (see the header there for the outbox lifecycle, per-person storage
 * and session generations); this file wires it to the browser and React.
 *
 *   view = last known server state  +  this device's queued work (edits not yet confirmed)
 *
 * Edits apply to the view instantly and go into a persisted outbox, so nothing is lost
 * when the phone is offline or the tab is closed. Rejected work is kept and listed
 * (usePendingWork) until the person retries, exports or discards it.
 *
 * Nothing here touches browser globals until first use, so Node can import it.
 */

export type { Role, SyncInfo, SyncStatus, PendingWork, WorkReason, Connection } from './sync/engine.ts';
import type { PendingWork } from './sync/engine.ts';

function browserDeps(): EngineDeps {
  const nav = globalThis.navigator as Navigator | undefined;
  const locks = nav && 'locks' in nav ? nav.locks : undefined;
  return {
    storage: idbStorage(),
    prefs: safePrefs(() => globalThis.localStorage),
    fetch: (input, init) => fetch(input, init),
    eventSource: (url) => new EventSource(url),
    locks: locks
      ? {
          request: (name, options, fn) => locks.request(name, options, fn) as Promise<never>,
          query: () => locks.query() as Promise<{ held?: { name?: string }[] }>,
        }
      : undefined,
    confirm: (message) => globalThis.confirm?.(message) ?? true,
    download: (json, filename) => downloadBlob(new Blob([json], { type: 'application/json' }), filename),
  };
}

let engine: Engine | null = null;
const E = () => (engine ??= createEngine(browserDeps()));

/** Tests (and only tests) may swap in an engine built with fake dependencies. */
export function setEngineForTests(e: Engine | null) {
  engine = e;
}

const subscribe = (l: () => void) => E().subscribe(l);

/* ---------- sync + identity ---------- */

export const connect = () => E().connect();
export const login = (code: string) => E().login(code);
export const useSync = () => useSyncExternalStore(subscribe, () => E().getSync());
/** A store team member says who they are (once per phone). Returns an error message, or null. */
export const setMyName = (name: string) => E().setMyName(name);
/** Shows the "your name" question again ("Change name"); `false` puts it away. */
export const askName = (ask = true) => E().askName(ask);

/** Set on sign-out so the sign-in page can say so. */
export const SIGNED_OUT_KEY = 'fd-signed-out';

/** Signs out and wipes this person's copy on this device (asks first, with a download, if work is unsent). */
export async function logout() {
  const role = E().getSync().role;
  if (!(await E().logout())) return;
  clearPhotoUrls();
  try {
    sessionStorage.setItem(SIGNED_OUT_KEY, '1');
  } catch {
    /* the note is a nicety */
  }
  // Each role goes back to its own door: field admins to "/", HQ to "/hq".
  location.replace(role === 'super' ? '/hq' : '/');
}

/** `code` comes from a personal or store-team link (https://host/K7Q2): sign in with it before connecting. */
export async function loadState(code?: string) {
  await E().start(code);
  window.addEventListener('online', () => E().nudge());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && E().nudge());
}

/* ---------- work queue (CONTRACT) ---------- */

/** Queue a server-authoritative command; applied optimistically, returns the work id. */
export const sendCommand = (storeId: string, cmd: Command): string => E().sendCommand(storeId, cmd);

/** Pending / failed / held work, optionally for one store. Re-renders on change. */
export function usePendingWork(storeId?: string): PendingWork[] {
  const all = useSyncExternalStore(subscribe, () => E().getPending());
  return useMemo(() => (storeId ? all.filter((w) => w.storeId === storeId) : all), [all, storeId]);
}

/** Re-send failed work as a new attempt (held work from before the update: send it as me). */
export const retryWork = (id: string) => E().retryWork(id);
/** Give up on failed work (after the user has seen / exported it). */
export const discardWork = (id: string) => E().discardWork(id);
/** Send everything held from before the update, as the person signed in now. */
export const sendHeldWork = () => E().sendHeldWork();
/** Download all unsent work (edits, commands, photos) as JSON. */
export const exportWork = () => E().exportWork();
export const getPendingWork = () => E().getPending();

/* ---------- state API ---------- */

export const getState = () => E().getState();
export const update = (fn: (draft: AppState) => void) => E().update(fn);

export function replaceState(next: AppState) {
  update((d) => {
    d.events = next.events;
    d.stores = next.stores;
    d.admins = next.admins ?? d.admins;
    d.accounts = next.accounts ?? d.accounts;
  });
}

export function updateStore(id: string, fn: (s: Store) => void) {
  update((d) => {
    const s = d.stores[id];
    if (!s) return;
    fn(s);
    s.updatedAt = new Date().toISOString();
  });
}

/** Selector must return a reference that already lives in state (not a fresh object). */
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(E().getState()));
}

/* ---------- factories ---------- */

export function newEvent(partial: Partial<TournamentEvent>): TournamentEvent {
  return {
    id: uid(),
    name: 'Untitled tournament',
    date: todayLocal(),
    games: [],
    collateral: ['Printed posters', 'Standee', 'Prize cheque'],
    gameReadyTarget: 4,
    minDownMbps: 25,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

export function newRecce(): Recce {
  return {
    status: 'draft',
    venue: { photos: [] },
    laptops: [],
    network: { wifi: null, lan: null, speed: null, photos: [] },
    furniture: { setup: null, chairType: '', chairCount: null, tablecloth: null, photos: [] },
    collateral: { posters: false, standee: false, cheque: false, standeePhotos: [], chequePhotos: [], chequeInStandeePhoto: false },
    summary: '',
  };
}

export function newStore(eventId: string, partial: Partial<Store>): Store {
  return {
    id: uid(),
    eventId,
    name: 'New store',
    city: '',
    address: '',
    admin: '',
    pin: null,
    recce: newRecce(),
    day: { players: [], checkIn: {}, matches: [], stations: 2 },
    adminId: null,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

/** Resize the laptop list, keeping existing entries. First N are game stations, next is the admin PC, rest spare. */
export function resizeLaptops(list: Laptop[], count: number, target: number): Laptop[] {
  const out = list.slice(0, count);
  while (out.length < count) {
    out.push({ id: uid(), label: '', role: 'spare', games: {}, launched: {}, drivers: false, windows: false, notes: '', photos: [] });
  }
  return out.map((l, i) => ({
    ...l,
    label: `Laptop ${String(i + 1).padStart(2, '0')}`,
    role: i < target ? 'game' : i === target ? 'admin' : 'spare',
  }));
}

/* ---------- photos ---------- */

/** Stores the photo on this device and queues its upload, tagged with the store it belongs to. */
export const savePhoto = (id: string, blob: Blob, storeId: string) => E().savePhoto(id, blob, storeId);

/** Removes the local copy (and a not-yet-sent upload). The server keeps every uploaded proof photo. */
export async function deletePhoto(id: string) {
  dropUrl(id);
  await E().deletePhoto(id);
}

/** Local copies first; anything missing is fetched from the server and cached. */
export const getPhotos = (ids: string[]) => E().getPhotos(ids);

// Object URLs, least recently used first; bounded so a long session doesn't hold every photo.
const URL_CACHE_MAX = 200;
const urlCache = new Map<string, string>();
let urlPrincipal: string | null | undefined;

function dropUrl(id: string) {
  const u = urlCache.get(id);
  if (u) URL.revokeObjectURL(u);
  urlCache.delete(id);
}
function clearPhotoUrls() {
  for (const id of [...urlCache.keys()]) dropUrl(id);
}
function cachedUrl(id: string) {
  const u = urlCache.get(id);
  if (u) {
    urlCache.delete(id); // touch
    urlCache.set(id, u);
  }
  return u;
}
function putUrl(id: string, blob: Blob) {
  dropUrl(id);
  urlCache.set(id, URL.createObjectURL(blob));
  while (urlCache.size > URL_CACHE_MAX) dropUrl(urlCache.keys().next().value!);
}

/** Object URLs for photo ids. Photos still uploading from another device are retried for a while. */
export function usePhotoUrls(ids: string[]) {
  const key = ids.join(',');
  const principal = useSync().principal;
  if (principal !== urlPrincipal) {
    clearPhotoUrls(); // never show one person's photos to the next
    urlPrincipal = principal;
  }
  const pick = () => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const u = cachedUrl(id);
      if (u) out[id] = u;
    }
    return out;
  };
  const [urls, setUrls] = useState<Record<string, string>>(pick);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer: number | undefined;
    const load = async () => {
      const missing = ids.filter((id) => !urlCache.has(id));
      if (missing.length) {
        const blobs = await getPhotos(missing);
        if (!alive) return;
        for (const [id, b] of Object.entries(blobs)) if (b) putUrl(id, b);
      }
      if (!alive) return;
      setUrls(pick());
      if (ids.some((id) => !urlCache.has(id)) && ++tries < 30) timer = window.setTimeout(load, 4000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, principal]);
  return urls;
}

export { allPhotoRefs } from './recce.ts';
