import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, photoFiles, schemaVersion } from './migrate.ts';

/*
 * Disaster-recovery backups of a data directory: a consistent database copy, every photo file
 * and a manifest with counts and sha256 checksums.
 *
 *   node server/backup.ts <dataDir> <outDir>            make a backup (outDir must be new or empty)
 *   node server/backup.ts --verify <backupDir>          check a backup against its manifest
 *   node server/backup.ts --restore <backupDir> <newDataDir>   verify, then restore into an empty dir
 *
 * Safe while the server runs: the database is copied with VACUUM INTO from a read-only
 * connection (one consistent snapshot, WAL included). Photos are write-once, so every photo the
 * snapshot knows is already complete on disk; ones uploaded after the snapshot aren't included.
 * A backup holds admin codes and session hashes — store it like the data directory itself.
 */

export interface Manifest {
  format: 'field-desk-backup';
  version: 1;
  createdAt: string;
  source: string;
  schemaVersion: number;
  seq: number;
  counts: { events: number; stores: number; admins: number; photos: number; sessions: number };
  db: { file: string; bytes: number; sha256: string };
  photos: { id: string; bytes: number; sha256: string; storeId: string | null }[];
  missingPhotos: string[]; // known to the database, but no file was found
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const has = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

function summarize(db: DatabaseSync) {
  const kind = (k: string) => count(db, `SELECT COUNT(*) AS n FROM docs WHERE kind = '${k}'`);
  return {
    schemaVersion: schemaVersion(db),
    seq: Number((db.prepare("SELECT v FROM meta WHERE k = 'seq'").get() as { v: string } | undefined)?.v ?? 0),
    counts: {
      events: kind('events'),
      stores: kind('stores'),
      admins: kind('admins'),
      photos: has(db, 'photos') ? count(db, 'SELECT COUNT(*) AS n FROM photos') : 0,
      sessions: has(db, 'sessions') ? count(db, 'SELECT COUNT(*) AS n FROM sessions') : 0,
    },
  };
}

function emptyDir(dir: string, what: string) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${what} ${dir} isn’t empty — pick a new directory.`);
  fs.mkdirSync(dir, { recursive: true });
}

export function createBackup(dataDir: string, outDir: string): Manifest {
  const src = path.join(dataDir, DB_FILE);
  if (!fs.existsSync(src)) throw new Error(`No ${DB_FILE} in ${dataDir}`);
  emptyDir(outDir, 'Backup directory');
  const dbOut = path.join(outDir, DB_FILE);
  const live = new DatabaseSync(src, { readOnly: true });
  try {
    live.prepare('VACUUM INTO ?').run(dbOut);
  } finally {
    live.close();
  }

  // From here on, read only the snapshot.
  const snap = new DatabaseSync(dbOut, { readOnly: true });
  let info: ReturnType<typeof summarize>;
  let rows: { id: string; store_id: string | null }[];
  try {
    info = summarize(snap);
    rows = has(snap, 'photos') ? (snap.prepare('SELECT id, store_id FROM photos ORDER BY id').all() as typeof rows) : photoFiles(path.join(dataDir, 'photos')).map((id) => ({ id, store_id: null }));
  } finally {
    snap.close();
  }

  const photoOut = path.join(outDir, 'photos');
  fs.mkdirSync(photoOut);
  const photos: Manifest['photos'] = [];
  const missingPhotos: string[] = [];
  for (const r of rows) {
    const from = path.join(dataDir, 'photos', `${r.id}.jpg`);
    if (!fs.existsSync(from)) {
      missingPhotos.push(r.id);
      continue;
    }
    const buf = fs.readFileSync(from);
    fs.writeFileSync(path.join(photoOut, `${r.id}.jpg`), buf, { flag: 'wx' });
    photos.push({ id: r.id, bytes: buf.length, sha256: sha256(buf), storeId: r.store_id });
  }
  const dbBuf = fs.readFileSync(dbOut);
  const manifest: Manifest = {
    format: 'field-desk-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    source: path.resolve(dataDir),
    ...info,
    db: { file: DB_FILE, bytes: dbBuf.length, sha256: sha256(dbBuf) },
    photos,
    missingPhotos,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Problems with a backup ([] = complete and intact). */
export function verifyBackup(dir: string): string[] {
  const problems: string[] = [];
  let m: Manifest;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return ['manifest.json is missing or unreadable'];
  }
  if (m.format !== 'field-desk-backup' || m.version !== 1) return ['manifest.json isn’t a Field Desk backup manifest'];
  const dbFile = path.join(dir, m.db.file);
  if (!fs.existsSync(dbFile)) return [`${m.db.file} is missing`];
  if (sha256(fs.readFileSync(dbFile)) !== m.db.sha256) problems.push(`${m.db.file}: checksum doesn’t match the manifest`);
  else {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const ok = (db.prepare('PRAGMA integrity_check').get() as Record<string, string>).integrity_check;
      if (ok !== 'ok') problems.push(`${m.db.file}: integrity check failed (${ok})`);
      const info = summarize(db);
      for (const [k, v] of Object.entries(m.counts)) if ((info.counts as Record<string, number>)[k] !== v) problems.push(`count of ${k}: manifest ${v}, database ${(info.counts as Record<string, number>)[k]}`);
      if (info.seq !== m.seq) problems.push(`seq: manifest ${m.seq}, database ${info.seq}`);
    } finally {
      db.close();
    }
  }
  for (const p of m.photos) {
    const f = path.join(dir, 'photos', `${p.id}.jpg`);
    if (!fs.existsSync(f)) problems.push(`photo ${p.id} is missing`);
    else if (sha256(fs.readFileSync(f)) !== p.sha256) problems.push(`photo ${p.id}: checksum doesn’t match`);
  }
  if (m.missingPhotos?.length) problems.push(`${m.missingPhotos.length} photo(s) were already missing from the source: ${m.missingPhotos.slice(0, 10).join(', ')}`);
  return problems;
}

/** Verifies the backup, then copies it into an empty data directory. The server can start there right away. */
export function restoreBackup(dir: string, dataDir: string): Manifest {
  const problems = verifyBackup(dir);
  if (problems.length) throw new Error(`Backup ${dir} failed verification:\n  ${problems.join('\n  ')}`);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  emptyDir(dataDir, 'Data directory');
  fs.mkdirSync(path.join(dataDir, 'photos'));
  fs.copyFileSync(path.join(dir, m.db.file), path.join(dataDir, DB_FILE), fs.constants.COPYFILE_EXCL);
  for (const p of m.photos) fs.copyFileSync(path.join(dir, 'photos', `${p.id}.jpg`), path.join(dataDir, 'photos', `${p.id}.jpg`), fs.constants.COPYFILE_EXCL);
  return m;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--verify' && args[1]) {
      const problems = verifyBackup(path.resolve(args[1]));
      console.log(problems.length ? `Backup has problems:\n  ${problems.join('\n  ')}` : 'Backup OK.');
      process.exit(problems.length ? 1 : 0);
    } else if (args[0] === '--restore' && args[1] && args[2]) {
      const m = restoreBackup(path.resolve(args[1]), path.resolve(args[2]));
      console.log(`Restored backup of ${m.createdAt} (seq ${m.seq}, ${m.counts.stores} stores, ${m.photos.length} photos) into ${path.resolve(args[2])}.`);
    } else if (args.length === 2 && !args[0].startsWith('--')) {
      const m = createBackup(path.resolve(args[0]), path.resolve(args[1]));
      console.log(`Backup written to ${path.resolve(args[1])}: seq ${m.seq}, ${m.counts.events} campaigns, ${m.counts.stores} stores, ${m.counts.admins} admins, ${m.photos.length} photos${m.missingPhotos.length ? `, ${m.missingPhotos.length} MISSING` : ''}.`);
      process.exit(m.missingPhotos.length ? 1 : 0);
    } else {
      console.error('Usage:\n  node server/backup.ts <dataDir> <outDir>\n  node server/backup.ts --verify <backupDir>\n  node server/backup.ts --restore <backupDir> <newDataDir>');
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
