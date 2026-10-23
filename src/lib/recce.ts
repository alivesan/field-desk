import type { GeoFix, Laptop, PhotoRef, Recce, Store } from './types.ts';

/**
 * Fills in fields added after a recce was started, and maps older collateral data onto
 * the current checklist. Mutates and returns `r` — call it on a draft before editing.
 */
export function ensureRecce(r: Recce): Recce {
  r.venue ??= { photos: [] };
  r.venue.photos ??= [];
  r.laptops ??= [];
  for (const l of r.laptops) l.launched ??= {};
  r.network ??= { wifi: null, lan: null, speed: null, photos: [] };
  r.network.photos ??= [];
  r.furniture ??= { setup: null, chairType: '', chairCount: null, tablecloth: null, photos: [] };
  r.furniture.photos ??= [];
  const c = (r.collateral ??= {} as Recce['collateral']);
  if (c.posters === undefined) {
    const placed = c.placed ?? {};
    c.posters = !!placed['Printed posters'];
    c.standee = !!placed['Standee'];
    c.cheque = !!placed['Prize cheque'];
    c.standeePhotos = c.photos ?? [];
    c.chequePhotos = [];
    c.chequeInStandeePhoto = false;
  }
  c.standeePhotos ??= [];
  c.chequePhotos ??= [];
  r.summary ??= '';
  return r;
}

/** A filled-in copy for reading, without touching state. */
export const readRecce = (r: Recce) => ensureRecce(structuredClone(r));

export function allPhotoRefs(store: Store): PhotoRef[] {
  return reccePhotoRefs(store.recce);
}

/** Every proof photo a recce references, in report order. */
export function reccePhotoRefs(recce: Recce): PhotoRef[] {
  const r = readRecce(recce);
  return [
    ...r.venue.photos,
    ...r.furniture.photos,
    ...r.laptops.flatMap((l) => l.photos),
    ...r.network.photos,
    ...r.collateral.standeePhotos,
    ...r.collateral.chequePhotos,
  ];
}

/**
 * The working draft's photos plus every photo a submitted revision still references, once
 * each — what a backup must carry, and what HQ may need to open for an older revision.
 */
export function allEvidenceRefs(store: Store): PhotoRef[] {
  const seen = new Set<string>();
  const out: PhotoRef[] = [];
  for (const p of [...allPhotoRefs(store), ...(store.submissions ?? []).flatMap((s) => reccePhotoRefs(s.recce))]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Laptops that resizing the list to `count` would drop while they still hold checks, notes or photos. */
export function laptopsLostOnResize(list: Laptop[], count: number): Laptop[] {
  return list.slice(Math.max(0, count)).filter((l) => l.photos.length > 0 || l.notes.trim() !== '' || l.drivers || l.windows || Object.values(l.games).some(Boolean) || Object.values(l.launched ?? {}).some(Boolean));
}

/** This store's tournament day (a campaign can run across several days). */
export const storeDate = (store: Store, event: { date: string }) => store.date || event.date;

/** "24 Oct" or "24–25 Oct" across a campaign's stores. */
export function dateSpan(event: { date: string }, stores: Store[]) {
  const ds = [...new Set(stores.map((s) => storeDate(s, event)))].sort();
  if (!ds.length) ds.push(event.date);
  // Built by hand so it always reads day-first ("24–25 October 2026"), whatever the browser locale.
  const parts = (d: string) => {
    const x = new Date(d + 'T00:00:00');
    return { day: x.getDate(), month: x.toLocaleDateString(undefined, { month: 'long' }), year: x.getFullYear(), weekday: x.toLocaleDateString(undefined, { weekday: 'long' }) };
  };
  const a = parts(ds[0]);
  const b = parts(ds[ds.length - 1]);
  if (ds.length === 1) return `${a.weekday}, ${a.day} ${a.month} ${a.year}`;
  if (a.month === b.month && a.year === b.year) return `${a.day}–${b.day} ${b.month} ${b.year}`;
  return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}`;
}

/** Where the venue is: HQ's Maps link if it had coordinates, else the first geotagged photo. */
export const venueRef = (store: Store): GeoFix | null => store.geo ?? store.pin ?? null;

/**
 * How far the venue reference can be trusted: 'hq' = read from HQ's Maps link (verified),
 * 'provisional' = the first device-geotagged proof photo (it only shows the photos agree with
 * each other, not that they were taken at the store), 'none' = nothing to check against.
 */
export const venueRefKind = (store: Store): 'hq' | 'provisional' | 'none' => (store.geo ? 'hq' : store.pin ? 'provisional' : 'none');

/** Longest Maps link we bother parsing — real ones are a few hundred characters. */
const MAX_MAPS_URL = 4096;

/**
 * Coordinates from a Google Maps URL, when it carries them:
 * place pins (!3d…!4d…), ?q= / query= / ll= / destination=, /place/lat,lng and @lat,lng.
 * Short links (maps.app.goo.gl) need resolving first — see /api/resolve-map.
 * Never throws: anything malformed, oversized or not http(s) is simply "no coordinates".
 */
export function coordsFromMapsUrl(url: string): GeoFix | null {
  try {
    if (typeof url !== 'string') return null;
    const raw = url.trim();
    if (!raw || raw.length > MAX_MAPS_URL) return null;
    const ok = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    const pair = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    let s = u.href;
    try {
      s = decodeURIComponent(u.href);
    } catch {
      /* broken percent-encoding (e.g. "/%") — match against the raw link instead */
    }
    const pin = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (pin && ok(+pin[1], +pin[2])) return { lat: +pin[1], lng: +pin[2], accuracy: 0 };
    for (const k of ['q', 'query', 'll', 'destination', 'center']) {
      const m = u.searchParams.get(k)?.match(pair);
      if (m && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2], accuracy: 0 };
    }
    const place = s.match(/\/place\/(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/) ?? s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
    if (place && ok(+place[1], +place[2])) return { lat: +place[1], lng: +place[2], accuracy: 0 };
    return null;
  } catch {
    return null;
  }
}

/** Why a Maps link can't be used at all ('' = fine or empty). Coordinates may still be missing. */
export function mapsUrlProblem(url: string): string {
  const raw = url.trim();
  if (!raw) return '';
  if (raw.length > MAX_MAPS_URL) return 'That link is too long — copy it again from Share in Google Maps.';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'That isn’t a web link — paste the https:// link from Share in Google Maps.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only https:// Maps links can be used.';
  return '';
}

export const isShortMapsLink = (url: string) => typeof url === 'string' && url.length <= MAX_MAPS_URL && /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(url.trim());
