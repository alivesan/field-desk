import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Proof photo storage (F08). Files live at <dataDir>/photos/<id>.jpg; the `photos` table records
 * which store each one belongs to — the only thing reads are authorized by.
 *
 * Write-once, atomically: the bytes go to a private temp file, which is then hard-linked to the
 * final name (link fails if the name exists — no check-then-rename window), the temp name is
 * removed and the row recorded. Concurrent first uploads of one id are also serialized in
 * memory (one server process per data dir — see lock.ts), so exactly one wins.
 */

export interface PhotoRow {
  id: string;
  store_id: string | null;
  uploader: string;
  size: number;
  sha256: string;
  created_at: number;
}

export type PutResult = 'created' | 'same' | 'claimed';

export class PhotoConflict extends Error {}
export class PhotoQuota extends Error {}

const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function createPhotoStore(db: DatabaseSync, photoDir: string, now: () => number) {
  fs.mkdirSync(photoDir, { recursive: true });
  // Temp files left by a crash mid-upload.
  for (const f of fs.readdirSync(photoDir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(photoDir, f), { force: true });

  const get = db.prepare('SELECT * FROM photos WHERE id = ?');
  const insert = db.prepare('INSERT INTO photos (id, store_id, uploader, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const claim = db.prepare('UPDATE photos SET store_id = ? WHERE id = ? AND store_id IS NULL');
  const count = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE store_id = ?');
  const inflight = new Map<string, Promise<unknown>>();

  const file = (id: string) => path.join(photoDir, `${id}.jpg`);

  async function create(id: string, storeId: string, uploader: string, buf: Buffer, sha: string): Promise<PutResult> {
    const tmp = `${file(id)}.${randomBytes(6).toString('hex')}.tmp`;
    const fh = await fs.promises.open(tmp, 'wx');
    try {
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.promises.link(tmp, file(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A file without a row: a crash between link and insert. Same bytes → adopt it.
      const existing = await fs.promises.readFile(file(id));
      if (createHash('sha256').update(existing).digest('hex') !== sha) throw new PhotoConflict('A different photo already has this id.');
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    insert.run(id, storeId, uploader, buf.length, sha, now());
    return 'created';
  }

  return {
    file,
    row: (id: string) => get.get(id) as PhotoRow | undefined,
    countFor: (storeId: string) => (count.get(storeId) as { n: number }).n,
    isJpeg,
    /**
     * Stores `buf` as photo `id` of `storeId`. Retrying the same bytes for the same store is fine
     * ('same'); an unowned legacy file is claimed by whoever re-sends its exact bytes ('claimed');
     * anything else under an existing id throws PhotoConflict.
     */
    async put(id: string, storeId: string, uploader: string, buf: Buffer, maxPerStore = Infinity): Promise<PutResult> {
      const sha = createHash('sha256').update(buf).digest('hex');
      while (inflight.has(id)) await inflight.get(id)!.catch(() => {});
      const row = get.get(id) as PhotoRow | undefined;
      if (row) {
        if (row.sha256 !== sha) throw new PhotoConflict('A different photo already has this id.');
        if (row.store_id === storeId) return 'same';
        if (row.store_id === null && claim.run(storeId, id).changes) return 'claimed';
        throw new PhotoConflict('This photo belongs to another store.');
      }
      // Approximate under concurrency (uploads still writing aren't counted) — a bound, not an exact quota.
      if ((count.get(storeId) as { n: number }).n >= maxPerStore) throw new PhotoQuota(`This store already has ${maxPerStore} photos.`);
      const p = create(id, storeId, uploader, buf, sha);
      inflight.set(id, p);
      try {
        return await p;
      } finally {
        inflight.delete(id);
      }
    },
  };
}

export type PhotoStore = ReturnType<typeof createPhotoStore>;
