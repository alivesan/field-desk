/*
 * Evidence manifests — which proof photos an artifact (PDF, HTML file, backup) must contain,
 * which of them actually loaded, and what to say when some didn't. Pure: the loading itself
 * is in evidenceLoad.ts (browser). An artifact is only "complete" when every expected photo
 * was fetched AND decoded; otherwise it carries a banner naming what's missing.
 */
import type { PhotoRef, Recce, Store } from './types.ts';
import { readRecce } from './recce.ts';

export interface ExpectedPhoto {
  id: string;
  label: string;
  section: string; // where it sits in the report, e.g. "Laptops"
  storeId?: string;
}

/** Why a photo didn't make it: not on this device nor the server, or the bytes aren't an image. */
export type PhotoProblem = 'missing' | 'undecodable';
export type PhotoCheck = { ok: true } | { ok: false; problem: PhotoProblem; detail?: string };

export interface MissingPhoto extends ExpectedPhoto {
  problem: PhotoProblem;
  detail?: string;
}

export interface ManifestResult {
  expected: number;
  included: number;
  missing: MissingPhoto[];
  complete: boolean;
}

/** The photos a recce's report shows, in report order, once each. */
export function expectedPhotos(recce: Recce, storeId?: string): ExpectedPhoto[] {
  const r = readRecce(recce);
  const groups: [string, PhotoRef[]][] = [
    ['Venue', r.venue.photos],
    ['Setup', r.furniture.photos],
    ['Laptops', r.laptops.flatMap((l) => l.photos)],
    ['Internet', r.network.photos],
    ['Collateral', [...r.collateral.standeePhotos, ...r.collateral.chequePhotos]],
  ];
  const seen = new Set<string>();
  const out: ExpectedPhoto[] = [];
  for (const [section, list] of groups)
    for (const p of list) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, label: p.label || 'Photo', section, storeId });
    }
  return out;
}

/** Everything a store's evidence includes: the working draft plus every submitted revision, once each. */
export function storeEvidence(store: Store): ExpectedPhoto[] {
  const seen = new Set<string>();
  const out: ExpectedPhoto[] = [];
  for (const r of [store.recce, ...(store.submissions ?? []).map((s) => s.recce)])
    for (const p of r ? expectedPhotos(r, store.id) : [])
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
  return out;
}

/** Compare what was expected with what loaded. A photo with no check result counts as missing. */
export function diffManifest(expected: ExpectedPhoto[], checks: Record<string, PhotoCheck | undefined>): ManifestResult {
  const missing: MissingPhoto[] = [];
  for (const e of expected) {
    const c = checks[e.id];
    if (!c) missing.push({ ...e, problem: 'missing' });
    else if (!c.ok) missing.push({ ...e, problem: c.problem, detail: c.detail });
  }
  return { expected: expected.length, included: expected.length - missing.length, missing, complete: missing.length === 0 };
}

const PROBLEM_TEXT: Record<PhotoProblem, string> = {
  missing: 'not on this device or the server yet',
  undecodable: 'file is damaged or not an image',
};

export interface EvidenceBanner {
  title: string;
  lines: string[];
}

/** The banner an incomplete artifact must carry, or null when every photo is in. */
export function evidenceBanner(m: ManifestResult): EvidenceBanner | null {
  if (m.complete) return null;
  const n = m.missing.length;
  return {
    title: `Incomplete evidence — ${n} of ${m.expected} proof photo${m.expected === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} missing from this copy`,
    lines: m.missing.map((p) => `${p.section} · ${p.label} (photo ${p.id.slice(0, 6)}) — ${PROBLEM_TEXT[p.problem]}`),
  };
}

/** One line for the export prompt: "2 photos couldn't be loaded: Venue · Play area, …". */
export function missingSummary(m: ManifestResult, max = 4): string {
  const names = m.missing.map((p) => `${p.section} · ${p.label}`);
  const shown = names.slice(0, max).join('; ');
  return `${m.missing.length} of ${m.expected} photo${m.expected === 1 ? '' : 's'} couldn’t be loaded: ${shown}${names.length > max ? `; +${names.length - max} more` : ''}`;
}

/**
 * The report footer's claim about how photos were captured — only as strong as the photos
 * support. "In-app" = taken through the camera button, file fresh, with a device fix.
 */
export function provenanceSummary(photos: PhotoRef[]): string {
  if (!photos.length) return 'No proof photos.';
  const inApp = photos.filter((p) => (p.source === 'camera' || (!p.source && p.live)) && p.live !== false && p.geo && p.geoFrom !== 'photo').length;
  if (inApp === photos.length) return 'Every photo was taken in the app and stamped on-device with the time and the phone’s GPS at capture.';
  const noGeo = photos.filter((p) => !p.geo).length;
  const parts = [`${inApp} of ${photos.length} photos were taken in the app with the phone’s GPS`];
  if (noGeo) parts.push(`${noGeo} have no location`);
  return `${parts.join('; ')}. The others were uploaded or are flagged — capture time and place come from the file or its own stamp; see each photo’s notes.`;
}

/* ---------- backup manifest ---------- */

export interface BackupPhotoEntry {
  sha256: string;
  bytes: number;
  type: string;
}

export interface BackupManifest {
  expected: number; // photos referenced by any store or submitted revision
  included: number;
  complete: boolean;
  missing: { id: string; storeId?: string; label: string; problem: PhotoProblem }[];
  photos: Record<string, BackupPhotoEntry>;
}

export function backupManifest(result: ManifestResult, entries: Record<string, BackupPhotoEntry>): BackupManifest {
  return {
    expected: result.expected,
    included: result.included,
    complete: result.complete,
    missing: result.missing.map((m) => ({ id: m.id, storeId: m.storeId, label: `${m.section} · ${m.label}`, problem: m.problem })),
    photos: entries,
  };
}

/** Hex SHA-256 of some bytes (Web Crypto — available in browsers and Node). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
