import { getState, savePhoto, update } from './db.ts';
import { backupManifest, sha256Hex, storeEvidence, type BackupPhotoEntry, type ManifestResult } from './evidence.ts';
import { loadEvidence } from './evidenceLoad.ts';
import { BACKUP_FORMAT, BACKUP_KIND, parseBackup, planImport, type ImportOptions, type ImportPlan, type ParsedBackup } from './backupPlan.ts';
import { blobToDataUrl, dataUrlToBlob, todayLocal } from './util.ts';

/*
 * Backup file: state + every referenced proof photo, with a manifest (count, sha256 per photo,
 * and whether every photo made it). It's a portable copy of what this device can see — not a
 * substitute for backing up the server's database and photo folder.
 */

export interface PreparedBackup {
  evidence: ManifestResult;
  /** Builds the file. An incomplete one is marked so in its manifest and its file name. */
  build(): Promise<File>;
}

/** Step 1: fetch and decode every photo the backup should carry. Nothing is downloaded yet. */
export async function prepareBackup(): Promise<PreparedBackup> {
  const state = getState();
  const expected = Object.values(state.stores).flatMap(storeEvidence);
  const seen = new Set<string>();
  const unique = expected.filter((e) => !seen.has(e.id) && !!seen.add(e.id));
  const { result, blobs } = await loadEvidence(unique);
  return {
    evidence: result,
    async build() {
      const photos: Record<string, string> = {};
      const entries: Record<string, BackupPhotoEntry> = {};
      for (const [id, b] of Object.entries(blobs)) {
        photos[id] = await blobToDataUrl(b);
        entries[id] = { sha256: await sha256Hex(await b.arrayBuffer()), bytes: b.size, type: b.type || 'image/jpeg' };
      }
      const manifest = backupManifest(result, entries);
      const body = { kind: BACKUP_KIND, format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), manifest, state, photos };
      const name = `field-desk-backup-${todayLocal()}${result.complete ? '' : '-INCOMPLETE'}.json`;
      return new File([JSON.stringify(body)], name, { type: 'application/json' });
    },
  };
}

/** Step 1 of import: read + validate the whole file and plan it. No side effects. */
export async function readBackup(file: File): Promise<{ ok: true; backup: ParsedBackup } | { ok: false; errors: string[] }> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, errors: ['Couldn’t read that file.'] };
  }
  return parseBackup(text);
}

export const planBackupImport = (backup: ParsedBackup, opts: ImportOptions) => planImport(backup, getState(), opts);

/**
 * Step 2, after the user confirmed the preview: check every photo against its checksum, store
 * them (queued for upload ahead of the edits), then apply all record edits in one update.
 * If any photo fails its check nothing is applied. Returns how many record changes were queued —
 * they are on the server only once the sync status says so.
 */
export async function applyImport(plan: ImportPlan): Promise<{ changes: number; photos: number }> {
  if (!plan.ok) throw new Error('This import has errors — nothing was changed.');
  const blobs: { id: string; storeId: string; blob: Blob }[] = [];
  for (const p of plan.photos) {
    const blob = await dataUrlToBlob(p.data);
    if (p.sha256 && (await sha256Hex(await blob.arrayBuffer())) !== p.sha256) throw new Error(`Photo ${p.id.slice(0, 6)} doesn’t match its checksum — the file is damaged. Nothing was changed.`);
    blobs.push({ id: p.id, storeId: p.storeId, blob });
  }
  for (const b of blobs) await savePhoto(b.id, b.blob, b.storeId);
  if (plan.edits.length)
    update((d) => {
      for (const e of plan.edits) (d[e.kind] as Record<string, unknown>)[e.id] = structuredClone(e.doc);
    });
  return { changes: plan.edits.length, photos: blobs.length };
}
