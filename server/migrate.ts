import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeStore, validateDocument, PHOTO_ID } from '../src/lib/schema.ts';
import type { Store } from '../src/lib/types.ts';
import { consoleLogger, type Logger } from './log.ts';

/*
 * Database schema and migrations, keyed by meta.schema_version.
 *
 *   1  (implicit — no schema_version row) docs, batches(id, seq, at), meta
 *   2  batches.hash (payload sha256, F01); photos (server-side ownership, F08);
 *      sessions (revocable, expiring, F22); stores normalized to the current shape;
 *      photo files on disk backfilled into `photos`
 *
 * Every migration is idempotent and runs in one transaction with its version bump. Before
 * migrating an existing database, a consistent copy is written with
 * VACUUM INTO <dataDir>/backups/pre-migrate-<schema>-<timestamp>.db — that file is the rollback.
 *
 * CLI (read-only — never writes the database or photos; see openReadOnly for SQLite's side files):
 *   node server/migrate.ts --check <dataDir>
 * Reports the schema version, pending migrations, what normalization would change, document
 * problems after normalization, and photo files vs. references. Exit 0 = clean, 1 = problems.
 */

export const SCHEMA_VERSION = 2;
export const DB_FILE = 'field-desk.db';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function tableExists(db: DatabaseSync, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columns(db: DatabaseSync, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** 0 = empty database, 1 = the original schema (no version row), else meta.schema_version. */
export function schemaVersion(db: DatabaseSync): number {
  if (tableExists(db, 'meta')) {
    const row = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string } | undefined;
    if (row) return Number(row.v);
  }
  return tableExists(db, 'docs') ? 1 : 0;
}

/**
 * The Toornament result queue (docs/toornament-jobs.md): one row per job, `payload` immutable. A table, not a doc, so the
 * bot's churn stays off the SSE stream. Times are epoch milliseconds (like the other tables); `history` is a JSON list of
 * { at (ISO), state, code, attempt, workerId? }. tournament_id / stage_id repeat the payload's, for the worker's scope.
 * Created like the steam_otp_keys table: IF NOT EXISTS, no schema_version bump (an older build simply never reads it).
 */
export const TOORNAMENT_JOBS_DDL = `
  CREATE TABLE IF NOT EXISTS toornament_jobs (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'done', 'failed', 'needs-human', 'cancelled')),
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    tournament_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    worker_id TEXT,
    lease_until INTEGER,
    checkpoint_at INTEGER,
    next_attempt_at INTEGER,
    code TEXT,
    history TEXT NOT NULL DEFAULT '[]',
    UNIQUE (store_id, entity_id, revision));
  CREATE INDEX IF NOT EXISTS toornament_jobs_state ON toornament_jobs (state, created_at);
  CREATE INDEX IF NOT EXISTS toornament_jobs_store ON toornament_jobs (store_id, entity_id);
`;

function base(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id));
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  db.exec(TOORNAMENT_JOBS_DDL);
}

/** Photo ids referenced by a document: every list under a key ending in "photos", at any depth. */
export function photoIds(node: unknown, out = new Set<string>()) {
  if (Array.isArray(node)) node.forEach((n) => photoIds(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/photos$/i.test(k) && Array.isArray(v)) v.forEach((p) => typeof p?.id === 'string' && out.add(p.id));
      else photoIds(v, out);
    }
  }
  return out;
}

/** Photo files on disk, by id. */
export function photoFiles(photoDir: string) {
  if (!fs.existsSync(photoDir)) return [];
  return fs
    .readdirSync(photoDir)
    .filter((f) => f.endsWith('.jpg') && PHOTO_ID.test(f.slice(0, -4)))
    .map((f) => f.slice(0, -4));
}

/** Which store first references each photo (stores in id order) — and ids referenced by several. */
function photoOwners(stores: Store[]) {
  const owner = new Map<string, string>();
  const shared = new Set<string>();
  for (const s of [...stores].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const id of photoIds(s)) {
      if (!owner.has(id)) owner.set(id, s.id);
      else if (owner.get(id) !== s.id) shared.add(id);
    }
  }
  return { owner, shared };
}

interface MigrationCtx {
  photoDir: string;
  log: Logger;
}

const MIGRATIONS: { version: number; up: (db: DatabaseSync, ctx: MigrationCtx) => void }[] = [
  {
    version: 2,
    up(db, { photoDir, log }) {
      if (!columns(db, 'batches').includes('hash')) db.exec('ALTER TABLE batches ADD COLUMN hash TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY, store_id TEXT, uploader TEXT NOT NULL, size INTEGER NOT NULL,
          sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS photos_store ON photos (store_id);
        CREATE TABLE IF NOT EXISTS sessions (
          id_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, fp TEXT NOT NULL, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked_at INTEGER);
        CREATE INDEX IF NOT EXISTS sessions_principal ON sessions (principal);
      `);

      // Stores: upgrade legacy shapes in place.
      const save = db.prepare("UPDATE docs SET data = ? WHERE kind = 'stores' AND id = ?");
      const stores: Store[] = [];
      let normalized = 0;
      for (const row of db.prepare("SELECT id, data FROM docs WHERE kind = 'stores'").all() as { id: string; data: string }[]) {
        const s = normalizeStore(JSON.parse(row.data));
        const data = JSON.stringify(s);
        if (data !== row.data) {
          save.run(data, row.id);
          normalized++;
        }
        stores.push(s);
      }

      // Photos: every file on disk gets an ownership row — the store that first references it,
      // or none (HQ-only) when nothing does.
      const { owner, shared } = photoOwners(stores);
      const add = db.prepare("INSERT OR IGNORE INTO photos (id, store_id, uploader, size, sha256, created_at) VALUES (?, ?, 'migration', ?, ?, ?)");
      let orphans = 0;
      const files = photoFiles(photoDir);
      for (const id of files) {
        const file = path.join(photoDir, `${id}.jpg`);
        const buf = fs.readFileSync(file);
        const store = owner.get(id) ?? null;
        if (!store) orphans++;
        add.run(id, store, buf.length, sha256(buf), Math.round(fs.statSync(file).mtimeMs));
      }
      log('info', 'migrate-v2', { storesNormalized: normalized, photosRegistered: files.length, photosUnreferenced: orphans, photosSharedByStores: [...shared] });
    },
  },
];

export interface OpenResult {
  db: DatabaseSync;
  from: number;
  to: number;
  backup?: string;
}

/** Opens (creating if needed) the data directory's database and brings it to SCHEMA_VERSION. */
export function openDatabase(dataDir: string, log: Logger = consoleLogger): OpenResult {
  const photoDir = path.join(dataDir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const from = schemaVersion(db);
    if (from > SCHEMA_VERSION) {
      throw new Error(`${dataDir} was written by a newer Field Desk (schema ${from}; this build knows ${SCHEMA_VERSION}). Refusing to start — upgrade the app or restore a backup.`);
    }
    let backup: string | undefined;
    if (from >= 1 && from < SCHEMA_VERSION) {
      const dir = path.join(dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      backup = path.join(dir, `pre-migrate-${from}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      db.prepare('VACUUM INTO ?').run(backup);
      log('info', 'migrate-backup', { from, to: SCHEMA_VERSION, backup });
    }
    base(db);
    for (const m of MIGRATIONS) {
      if (m.version <= from) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        m.up(db, { photoDir, log });
        db.prepare("INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(m.version));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    return { db, from, to: SCHEMA_VERSION, backup };
  } catch (e) {
    db.close();
    throw e;
  }
}

/* ---------- read-only check ---------- */

/**
 * Opens a database file for reading without touching it. With no -wal file there is nothing
 * but the main file to read, so it is opened immutable (SQLite creates no side files at all);
 * otherwise read-only, which reads the WAL and may update the -shm index, never the data.
 */
export function openReadOnly(file: string) {
  const wal = `${file}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) return new DatabaseSync(file, { readOnly: true });
  const url = pathToFileURL(file);
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true });
}

export interface CheckReport {
  dataDir: string;
  schemaVersion: number;
  pendingMigrations: number[];
  counts: { events: number; stores: number; admins: number; accounts: number; batches: number; legacyBatches: number; photoFiles: number; photoRows: number | null };
  storesNormalizedOnMigrate: string[];
  problems: string[];
  photos: { referencedButMissing: string[]; unreferencedFiles: string[]; sharedByStores: string[] };
}

export function checkDataDir(dataDir: string): CheckReport {
  const file = path.join(dataDir, DB_FILE);
  if (!fs.existsSync(file)) throw new Error(`No ${DB_FILE} in ${dataDir}`);
  const db = openReadOnly(file);
  try {
    const version = schemaVersion(db);
    const rows = tableExists(db, 'docs') ? (db.prepare('SELECT kind, id, data FROM docs').all() as { kind: string; id: string; data: string }[]) : [];
    const docs: Record<string, Record<string, any>> = { events: {}, stores: {}, admins: {}, accounts: {} };
    const problems: string[] = [];
    const normalized: string[] = [];
    for (const r of rows) {
      let doc: any;
      try {
        doc = JSON.parse(r.data);
      } catch {
        problems.push(`${r.kind}/${r.id}: not valid JSON`);
        continue;
      }
      if (!(r.kind in docs)) {
        problems.push(`${r.kind}/${r.id}: unknown document kind`);
        continue;
      }
      if (r.kind === 'stores' && doc && typeof doc === 'object') {
        const before = JSON.stringify(doc);
        normalizeStore(doc);
        if (JSON.stringify(doc) !== before) normalized.push(r.id);
      }
      docs[r.kind][r.id] = doc;
    }
    const ctx = { events: docs.events, admins: docs.admins, accounts: docs.accounts };
    for (const kind of ['events', 'admins', 'accounts', 'stores'] as const) {
      for (const [id, doc] of Object.entries(docs[kind])) {
        if (doc?.id !== id) problems.push(`${kind}/${id}: id field ${JSON.stringify(doc?.id)} doesn’t match the row`);
        for (const p of validateDocument(kind, doc, ctx)) problems.push(`${kind}/${id}: ${p}`);
      }
    }
    const batchCols = tableExists(db, 'batches') ? columns(db, 'batches') : [];
    const batches = batchCols.length ? (db.prepare('SELECT COUNT(*) AS n FROM batches').get() as { n: number }).n : 0;
    const legacyBatches = batchCols.includes('hash') ? (db.prepare('SELECT COUNT(*) AS n FROM batches WHERE hash IS NULL').get() as { n: number }).n : batches;
    const photoRows = tableExists(db, 'photos') ? (db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n : null;

    const files = new Set(photoFiles(path.join(dataDir, 'photos')));
    const { owner, shared } = photoOwners(Object.values(docs.stores));
    return {
      dataDir,
      schemaVersion: version,
      pendingMigrations: MIGRATIONS.filter((m) => m.version > version).map((m) => m.version),
      counts: {
        events: Object.keys(docs.events).length,
        stores: Object.keys(docs.stores).length,
        admins: Object.keys(docs.admins).length,
        accounts: Object.keys(docs.accounts).length,
        batches,
        legacyBatches,
        photoFiles: files.size,
        photoRows,
      },
      storesNormalizedOnMigrate: version < 2 ? normalized : [],
      problems,
      photos: {
        referencedButMissing: [...owner.keys()].filter((id) => !files.has(id)),
        unreferencedFiles: [...files].filter((id) => !owner.has(id)),
        sharedByStores: [...shared],
      },
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [flag, dir] = process.argv.slice(2);
  if (flag !== '--check' || !dir) {
    console.error('Usage: node server/migrate.ts --check <dataDir>   (read-only report; migrations run when the server starts)');
    process.exit(2);
  }
  try {
    const report = checkDataDir(path.resolve(dir));
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.problems.length ? 1 : 0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
