/*
 * Test support for the sync engine (not a test file itself): a "device" (storage + prefs +
 * cookie jar), a fault-injecting fetch, a fetch-based EventSource for the real server, and a
 * scriptable fake API for cases the real server can't produce on demand.
 */
import { createEngine, type EngineDeps, type EventSourceLike } from '../src/lib/sync/engine.ts';
import { MemoryStorage, memoryPrefs } from '../src/lib/sync/storage.ts';

export type Intercept = (url: string, init: RequestInit, real: () => Promise<Response>) => Promise<Response | undefined> | undefined; // undefined → the real request

export interface Net {
  offline: boolean;
  intercept: Intercept | null;
  log: { method: string; path: string; body?: string; principal?: string | null; status?: number }[];
  streams: FetchEventSource[];
  fetch: typeof fetch;
}

/** One browser profile: IndexedDB, localStorage and cookies, shared by every "tab"/reload. */
export function device() {
  return { storage: new MemoryStorage(), prefs: memoryPrefs(), cookies: new Map<string, string>() };
}
export type Device = ReturnType<typeof device>;

/** fetch against `base` with the device's cookie jar, logging, an offline switch and an intercept hook. */
export function network(dev: Device, base: string): Net {
  const net: Net = {
    offline: false,
    intercept: null,
    log: [],
    streams: [],
    fetch: async (input, init = {}) => {
      const url = String(input);
      const path = url.startsWith(base) ? url.slice(base.length) : url;
      const headers = new Headers(init.headers);
      const entry: Net['log'][number] = { method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? init.body : undefined, principal: headers.get('X-Field-Desk-Principal') };
      net.log.push(entry);
      if (net.offline) throw new TypeError('fetch failed (offline)');
      const real = async () => {
        if (dev.cookies.size) headers.set('Cookie', [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
        const r = await fetch(base + path, { ...init, headers });
        for (const c of r.headers.getSetCookie?.() ?? []) {
          const [pair, ...attrs] = c.split(';');
          const [k, v] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()];
          if (!v || attrs.some((a) => /max-age=0/i.test(a.trim()))) dev.cookies.delete(k);
          else dev.cookies.set(k, v);
        }
        return r;
      };
      const r = (net.intercept && (await net.intercept(path, init, real))) || (await real());
      entry.status = r.status;
      return r;
    },
  };
  return net;
}

/** Minimal EventSource over fetch (Node has none by default). Comments are skipped, like a browser. */
export class FetchEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  received = 0;
  muted = false; // drop messages (a lost confirmation)
  private ctrl = new AbortController();
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(url: string, fetchImpl: typeof fetch) {
    void this.run(url, fetchImpl);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  private async run(url: string, fetchImpl: typeof fetch) {
    try {
      const r = await fetchImpl(url, { headers: { Accept: 'text/event-stream' }, signal: this.ctrl.signal });
      if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
      this.readyState = 1;
      this.onopen?.({});
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            else if (line.startsWith('event:')) type = line.slice(6).trim();
          }
          if (!data.length || this.muted || this.readyState === 2) continue;
          this.received++;
          const ev = { data: data.join('\n') };
          if (type === 'message') this.onmessage?.(ev);
          else this.listeners.get(type)?.forEach((fn) => fn(ev));
        }
      }
      throw new Error('stream ended');
    } catch {
      if (this.readyState === 2) return;
      this.readyState = 2;
      this.onerror?.({});
    }
  }
  close() {
    this.readyState = 2;
    this.ctrl.abort();
  }
}

/** A controllable EventSource for fake-API tests. */
export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close() {
    this.readyState = 2;
  }
}

/** An engine on a device. Several engines on one device = reloads (stop the old one first). */
export function engineOn(dev: Device, net: Pick<Net, 'fetch'>, eventSource: (url: string) => EventSourceLike, extra: Partial<EngineDeps> = {}) {
  return createEngine({
    storage: dev.storage,
    prefs: dev.prefs,
    fetch: net.fetch,
    eventSource,
    confirm: () => true,
    warn: () => {},
    ...extra,
  });
}

/** Engine on the real test server, with a real (fetch-based) stream through the same jar. */
export function realEngine(dev: Device, net: Net, extra: Partial<EngineDeps> = {}) {
  return engineOn(
    dev,
    net,
    (url) => {
      const s = new FetchEventSource(url, net.fetch);
      net.streams.push(s);
      return s;
    },
    extra,
  );
}

export async function waitFor(cond: () => unknown, what = 'condition', ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = !!(await cond());
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
