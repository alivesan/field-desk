/*
 * Browser side of the evidence manifest: fetch every expected photo (local copy, else the
 * server) and prove it decodes. Photos that are merely referenced, still uploading from
 * another phone, or damaged come back as missing — see evidence.ts for what to do with that.
 */
import { getPhotos } from './db.ts';
import { diffManifest, type ExpectedPhoto, type ManifestResult, type PhotoCheck } from './evidence.ts';

export interface LoadedEvidence {
  result: ManifestResult;
  blobs: Record<string, Blob>; // only the photos that decoded
}

/** Does this blob decode to an image with real pixels? */
export async function decodes(blob: Blob): Promise<PhotoCheck> {
  if (!blob.size) return { ok: false, problem: 'undecodable', detail: 'empty file' };
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      const ok = bmp.width > 0 && bmp.height > 0;
      bmp.close();
      return ok ? { ok: true } : { ok: false, problem: 'undecodable', detail: 'no pixels' };
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth > 0 ? { ok: true } : { ok: false, problem: 'undecodable', detail: 'no pixels' };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    return { ok: false, problem: 'undecodable', detail: (e as Error).message };
  }
}

export async function loadEvidence(expected: ExpectedPhoto[]): Promise<LoadedEvidence> {
  const ids = expected.map((e) => e.id);
  const found = ids.length ? await getPhotos(ids) : {};
  const checks: Record<string, PhotoCheck> = {};
  const blobs: Record<string, Blob> = {};
  await Promise.all(
    ids.map(async (id) => {
      const b = found[id];
      if (!b) return void (checks[id] = { ok: false, problem: 'missing' });
      const c = await decodes(b);
      checks[id] = c;
      if (c.ok) blobs[id] = b;
    }),
  );
  return { result: diffManifest(expected, checks), blobs };
}

/**
 * The on-screen report's own <img data-photo-id> elements: each must have decoded with
 * pixels before printing. Waits up to `timeoutMs` per image.
 */
export async function checkRenderedPhotos(root: ParentNode, expected: ExpectedPhoto[], timeoutMs = 8000): Promise<ManifestResult> {
  const checks: Record<string, PhotoCheck> = {};
  await Promise.all(
    expected.map(async (e) => {
      const img = root.querySelector<HTMLImageElement>(`img[data-photo-id="${CSS.escape(e.id)}"]`);
      if (!img) return void (checks[e.id] = { ok: false, problem: 'missing' });
      try {
        await Promise.race([img.decode(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), timeoutMs))]);
        checks[e.id] = img.naturalWidth > 0 ? { ok: true } : { ok: false, problem: 'undecodable' };
      } catch (err) {
        checks[e.id] = { ok: false, problem: img.complete && img.naturalWidth === 0 ? 'undecodable' : 'missing', detail: (err as Error).message };
      }
    }),
  );
  return diffManifest(expected, checks);
}
