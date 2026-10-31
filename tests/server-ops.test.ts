import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, seedBasic, fixtureEvent, fixtureAdmin, SUPER, TINY_JPEG } from './helpers/server.ts';
import { createBackup, restoreBackup, verifyBackup } from '../server/backup.ts';
import { createApi } from '../server/api.ts';
import { silentLogger } from '../server/log.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const root = path.resolve(import.meta.dirname, '..');
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree = (dir: string) =>
  Object.fromEntries(
    (fs.readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => [f.replaceAll('\\', '/'), sha(path.join(dir, f))]),
  );

const photoRef = (id: string) => ({ id, label: 'Standee', takenAt: '2026-09-01T10:00:00.000Z', fileTime: '2026-09-01T10:00:00.000Z', live: true, geo: null });

/** A data directory as the previous release left it: schema 1, legacy store shapes, photos without rows, batches without hashes. */
function legacyDataDir() {
  const dir = tmp('fd-legacy-');
  fs.mkdirSync(path.join(dir, 'photos'));
  const db = new DatabaseSync(path.join(dir, 'field-desk.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id));
    CREATE TABLE batches (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  const put = db.prepare('INSERT INTO docs (kind, id, data) VALUES (?, ?, ?)');
  put.run('events', 'e1', JSON.stringify(fixtureEvent('e1')));
  put.run('admins', 'a1', JSON.stringify(fixtureAdmin('a1', 'AAA2')));
  put.run('admins', 'a2', JSON.stringify(fixtureAdmin('a2', 'BBB3')));
  const legacyStore = (id: string, adminId: string, photo: string) => ({
    id,
    eventId: 'e1',
    name: `Old ${id}`,
    city: 'Pune',
    address: '',
    admin: `Synthetic ${adminId}`,
    adminId,
    pin: null,
    // older recce: no furniture section, collateral as a free checklist + one photo list
    recce: { status: 'submitted', submittedAt: '2026-09-01T10:00:00.000Z', venue: { photos: [], area: 'Ground floor', notes: '' }, laptops: [], network: { wifi: 'yes', lan: 'no', speed: null, photos: [] }, collateral: { placed: { Standee: true, 'Printed posters': true }, handedTo: 'Ravi', photos: [photoRef(photo)] }, summary: 'ok' },
    day: { players: [], checkIn: {}, matches: [], stations: 2 }, // no version
  });
  put.run('stores', 's1', JSON.stringify(legacyStore('s1', 'a1', 'legacyp1')));
  put.run('stores', 's2', JSON.stringify(legacyStore('s2', 'a2', 'legacyp2')));
  db.prepare('INSERT INTO batches (id, seq, at) VALUES (?, ?, ?)').run('legacy-batch-01', 4, Date.now());
  db.prepare("INSERT INTO meta (k, v) VALUES ('secret', ?), ('seq', '4')").run('00'.repeat(32));
  db.close();
  for (const id of ['legacyp1', 'legacyp2', 'orphanp1']) fs.writeFileSync(path.join(dir, 'photos', `${id}.jpg`), TINY_JPEG);
  return dir;
}

test('migrate --check reports on a legacy data dir without writing anything', () => {
  const dir = legacyDataDir();
  const before = tree(dir);
  const r = spawnSync(process.execPath, [path.join(root, 'server/migrate.ts'), '--check', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const report = JSON.parse(r.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.pendingMigrations, [2]);
  assert.deepEqual(report.storesNormalizedOnMigrate.sort(), ['s1', 's2']);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.photos.unreferencedFiles, ['orphanp1']);
  assert.equal(report.counts.legacyBatches, 1);
  assert.deepEqual(tree(dir), before, 'the check must not touch the data dir');
});

test('migrate --check exits 1 and lists problems that normalization can’t fix', () => {
  const dir = legacyDataDir();
  const db = new DatabaseSync(path.join(dir, 'field-desk.db'));
  db.prepare("UPDATE docs SET data = json_set(data, '$.eventId', 'gone') WHERE id = 's2'").run();
  db.close();
  const r = spawnSync(process.execPath, [path.join(root, 'server/migrate.ts'), '--check', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stdout).problems.some((p: string) => /stores\/s2: eventId/.test(p)));
});

test('startup migration: backup first, legacy docs normalized, photos owned, legacy batch retry still idempotent; idempotent restart', async () => {
  const dir = legacyDataDir();
  const t = await startTestServer({ dataDir: dir });
  try {
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pre-migrate-1-.*\.db$/);
    // the pre-migration copy is the old schema, intact
    const old = new DatabaseSync(path.join(dir, 'backups', backups[0]), { readOnly: true });
    assert.equal((old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'photos'").get() as { n: number }).n, 0);
    assert.equal((old.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n, 5);
    old.close();

    const hq = await t.login(SUPER);
    const state = (await t.json('/api/state', { cookie: hq })).body;
    assert.equal(state.seq, 5, 'the four legacy commits, then the server giving each store its bracket link');
    assert.equal(state.stores.s1.day.version, 0);
    assert.equal(state.stores.s1.recce.collateral.standee, true);
    assert.deepEqual(state.stores.s1.recce.collateral.standeePhotos.map((p: any) => p.id), ['legacyp1']);
    assert.deepEqual(state.stores.s1.recce.furniture.photos, []);

    const a1 = await t.login('AAA2');
    assert.equal((await t.req('/api/photos/legacyp1', { cookie: a1 })).status, 200);
    assert.equal((await t.req('/api/photos/legacyp2', { cookie: a1 })).status, 404);
    assert.equal((await t.req('/api/photos/orphanp1', { cookie: a1 })).status, 404, 'unreferenced → HQ only');
    assert.equal((await t.req('/api/photos/orphanp1', { cookie: hq })).status, 200);
    // edits to migrated docs validate
    const edit = await t.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'post-migrate-1', ops: [{ k: 'stores', id: 's1', p: ['recce', 'furniture', 'setup'], v: 'standard' }] } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    // a batch committed before payload hashes existed: a retry returns its seq
    const retry = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'legacy-batch-01', ops: [] } });
    assert.equal(retry.body.seq, 4);
  } finally {
    await t.close();
  }
  const t2 = await startTestServer({ dataDir: dir });
  try {
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1, 'no second migration');
    const db = new DatabaseSync(path.join(dir, 'field-desk.db'), { readOnly: true });
    assert.equal((db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string }).v, '2');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n, 3);
    db.close();
  } finally {
    await t2.close();
  }
});

test('a data dir from a newer schema is refused', () => {
  const dir = tmp('fd-newer-');
  const db = new DatabaseSync(path.join(dir, 'field-desk.db'));
  db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '99');");
  db.close();
  assert.throws(() => createApi({ dataDir: dir, superCode: SUPER, log: silentLogger }), /newer Field Desk/);
  assert.ok(!fs.existsSync(path.join(dir, '.lock')), 'lock released after a failed start');
});

test('backup → verify → restore into a new dir → the API there serves identical state and photos', async () => {
  const t = await startTestServer();
  let stateBefore: any;
  const backupDir = path.join(tmp('fd-backup-'), 'b1');
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    assert.equal((await t.req('/api/photos/backupp1?store=s1', { method: 'PUT', cookie: a1, headers: { 'Content-Type': 'image/jpeg' }, body: TINY_JPEG })).status, 201);
    await t.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'backup-ref-001', ops: [{ k: 'stores', id: 's1', p: ['recce', 'venue', 'photos'], v: [photoRef('backupp1')] }] } });
    stateBefore = (await t.json('/api/state', { cookie: hq })).body;
    // the server is still running: the backup is taken live
    const r = spawnSync(process.execPath, [path.join(root, 'server/backup.ts'), t.dataDir, backupDir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally {
    await t.close();
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.stores, 2);
  assert.deepEqual(manifest.photos.map((p: any) => [p.id, p.storeId]), [['backupp1', 's1']]);
  assert.deepEqual(verifyBackup(backupDir), []);
  const v = spawnSync(process.execPath, [path.join(root, 'server/backup.ts'), '--verify', backupDir], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);

  const restored = path.join(tmp('fd-restore-'), 'data');
  restoreBackup(backupDir, restored);
  const t2 = await startTestServer({ dataDir: restored });
  try {
    const hq = await t2.login(SUPER);
    assert.deepEqual((await t2.json('/api/state', { cookie: hq })).body, stateBefore);
    const a1 = await t2.login('AAA2');
    const img = await t2.req('/api/photos/backupp1', { cookie: a1 });
    assert.equal(img.status, 200);
    assert.deepEqual(new Uint8Array(await img.arrayBuffer()), TINY_JPEG);
    // and it keeps working: new commits continue the sequence
    const next = await t2.json('/api/batch', { method: 'POST', cookie: a1, body: { id: 'after-restore1', ops: [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: 'restored' }] } });
    assert.equal(next.body.seq, stateBefore.seq + 1);
  } finally {
    await t2.close();
  }
  // restore refuses a non-empty target
  assert.throws(() => restoreBackup(backupDir, restored), /isn’t empty/);
});

test('backup verification catches a damaged photo or database', async () => {
  const t = await startTestServer();
  const backupDir = path.join(tmp('fd-backup-'), 'b2');
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    await t.req('/api/photos/damagep1?store=s1', { method: 'PUT', cookie: a1, headers: { 'Content-Type': 'image/jpeg' }, body: TINY_JPEG });
    createBackup(t.dataDir, backupDir);
  } finally {
    await t.close();
  }
  fs.appendFileSync(path.join(backupDir, 'photos', 'damagep1.jpg'), 'x');
  assert.ok(verifyBackup(backupDir).some((p) => /damagep1: checksum/.test(p)));
  assert.throws(() => restoreBackup(backupDir, path.join(tmp('fd-restore-'), 'x')), /failed verification/);
  fs.appendFileSync(path.join(backupDir, 'field-desk.db'), 'x');
  assert.ok(verifyBackup(backupDir).some((p) => /field-desk\.db: checksum/.test(p)));
});

test('single-instance lock: a second live process is refused; a stale lock is replaced', async () => {
  const dir = tmp('fd-lock-');
  // another live process "holds" the data dir
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => other.once('spawn', r));
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: other.pid, host: 'test', startedAt: 'now' }));
    assert.throws(() => createApi({ dataDir: dir, superCode: SUPER, log: silentLogger }), new RegExp(`pid ${other.pid}.*Stop it first`));
  } finally {
    other.kill();
  }
  await new Promise((r) => other.once('exit', r));
  // now it's stale
  const warnings: string[] = [];
  const api = createApi({ dataDir: dir, superCode: SUPER, log: (level, event, fields) => level === 'warn' && warnings.push(`${event} ${JSON.stringify(fields)}`) });
  try {
    assert.ok(warnings.some((w) => /stale-lock/.test(w) && new RegExp(`pid ${other.pid}`).test(w)), warnings.join('\n'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).pid, process.pid);
  } finally {
    api.close();
  }
  assert.ok(!fs.existsSync(path.join(dir, '.lock')), 'released on close');
});
