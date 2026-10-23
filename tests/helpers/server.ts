/*
 * Test helper: the real Field Desk API on a throwaway temp directory, with synthetic codes.
 * Never points at .data/ or reads .env.local.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApi } from '../../server/api.ts';
import { silentLogger } from '../../server/log.ts';
import { DB_FILE } from '../../server/migrate.ts';

export const SUPER = 'synthetic-hq-code-for-tests-0001';

export interface TestServer {
  base: string;
  dataDir: string;
  /** The API instance (its close() is called by close()). */
  api: ReturnType<typeof createApi>;
  /** Sign in; returns a Cookie header value. */
  login(code: string): Promise<string>;
  /** fetch against the server with an optional Cookie. */
  req(pathname: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  json<T = any>(pathname: string, init?: Omit<RequestInit, 'body'> & { cookie?: string; body?: any }): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function startTestServer(opts: { dataDir?: string; superCode?: string; [k: string]: unknown } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fd-test-'));
  const api = createApi({ log: silentLogger, ...opts, dataDir, superCode: opts.superCode ?? SUPER } as Parameters<typeof createApi>[0]);
  const server = http.createServer((q, r) => {
    api.handle(q, r).then((handled) => {
      if (!handled) {
        r.writeHead(404);
        r.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const req: TestServer['req'] = (pathname, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('Cookie', init.cookie);
    return fetch(base + pathname, { ...init, headers });
  };
  const json: TestServer['json'] = async (pathname, init = {}) => {
    const headers = new Headers(init.headers);
    let body = init.body;
    if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      body = JSON.stringify(body);
      headers.set('Content-Type', 'application/json');
    }
    const r = await req(pathname, { ...init, headers, body });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: r.status, body: parsed };
  };
  const login = async (code: string) => {
    const r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (!r.ok) throw new Error(`login failed ${r.status}: ${await r.text()}`);
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  return {
    base,
    dataDir,
    api,
    login,
    req,
    json,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          api.close();
          resolve();
        });
      }),
  };
}

/** Minimal valid documents for fixtures. */
export function fixtureEvent(id = 'e1', over: Record<string, unknown> = {}) {
  return { id, name: 'Synthetic Campaign', date: '2026-10-24', games: ['Game A'], collateral: [], gameReadyTarget: 4, minDownMbps: 25, createdAt: '2026-10-01T00:00:00.000Z', ...over };
}

export function fixtureAdmin(id: string, code: string, over: Record<string, unknown> = {}) {
  return { id, name: `Synthetic ${id}`, phone: '', code, createdAt: '2026-10-01T00:00:00.000Z', ...over };
}

export function fixtureStore(id: string, eventId: string, adminId: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    eventId,
    name: `Store ${id}`,
    city: 'Testville',
    address: '',
    admin: adminId ? `Synthetic ${adminId}` : '',
    adminId,
    pin: null,
    recce: {
      status: 'draft',
      venue: { photos: [] },
      laptops: [],
      network: { wifi: null, lan: null, speed: null, photos: [] },
      furniture: { setup: null, chairType: '', chairCount: null, tablecloth: null, photos: [] },
      collateral: { posters: false, standee: false, cheque: false, standeePhotos: [], chequePhotos: [], chequeInStandeePhoto: false },
      summary: '',
    },
    day: { players: [], checkIn: {}, matches: [], stations: 2, version: 0 },
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

/** Smallest valid JPEG-looking payload (SOI … EOI). */
export const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

/** Seed: one campaign, admins a1 (code AAA2) and a2 (BBB3), stores s1→a1, s2→a2. Returns HQ cookie. */
export async function seedBasic(t: TestServer) {
  const hq = await t.login(SUPER);
  const r = await t.json('/api/batch', {
    method: 'POST',
    cookie: hq,
    body: {
      id: 'seed-basic-0001',
      ops: [
        { k: 'events', id: 'e1', p: [], v: fixtureEvent('e1') },
        { k: 'admins', id: 'a1', p: [], v: fixtureAdmin('a1', 'AAA2') },
        { k: 'admins', id: 'a2', p: [], v: fixtureAdmin('a2', 'BBB3') },
        { k: 'stores', id: 's1', p: [], v: fixtureStore('s1', 'e1', 'a1') },
        { k: 'stores', id: 's2', p: [], v: fixtureStore('s2', 'e1', 'a2') },
      ],
    },
  });
  if (r.status !== 200) throw new Error(`seed failed ${r.status} ${JSON.stringify(r.body)}`);
  return hq;
}

/**
 * Overwrites one document straight in a (closed) test data dir's database — for state the API
 * only lets commands create (e.g. players with phones). Stop the server first; start a new one
 * on the same dataDir afterwards.
 */
export function writeDocForTests(dataDir: string, kind: 'events' | 'stores' | 'admins', doc: { id: string }) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.prepare('INSERT INTO docs (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data').run(kind, doc.id, JSON.stringify(doc));
  } finally {
    db.close();
  }
}
