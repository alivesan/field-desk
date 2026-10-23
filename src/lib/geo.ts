import type { GeoFix } from './types.ts';

/** A device location fix and when it was measured (ISO, from the position's own timestamp). */
export interface TimedFix {
  fix: GeoFix;
  at: string;
}

/** A fix reused for a photo must be at most this old when the photo comes back from the camera. */
export const FIX_REUSE_MS = 60 * 1000;

/** Coarser than this and a fix can't place a photo at the venue — flagged. */
export const POOR_ACCURACY_M = 100;

/** The phone's location, with when it was measured. `maxAge` = how old a cached fix the browser may hand back. */
export function getTimedFix(timeout = 15000, maxAge = 20000): Promise<TimedFix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Geolocation not supported on this device'));
    if (!window.isSecureContext) return reject(new Error('Location needs HTTPS'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ fix: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }, at: new Date(p.timestamp || Date.now()).toISOString() }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : e.message || 'Location unavailable')),
      { enableHighAccuracy: true, timeout, maximumAge: maxAge },
    );
  });
}

export function getFix(timeout = 15000): Promise<GeoFix> {
  return getTimedFix(timeout).then((t) => t.fix);
}

/**
 * The prewarmed fix (requested when the camera opened) if it is recent enough to stand for the
 * moment the photo came back, else null — then take a fresh one.
 */
export function freshFix(prewarmed: TimedFix | Error | null | undefined, now: number, maxAgeMs = FIX_REUSE_MS): TimedFix | null {
  if (!prewarmed || prewarmed instanceof Error) return null;
  const at = Date.parse(prewarmed.at);
  if (!Number.isFinite(at)) return null;
  return now - at <= maxAgeMs && at - now <= maxAgeMs ? prewarmed : null;
}

/** Distance in metres (haversine). */
export function distanceM(a: GeoFix, b: GeoFix) {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export function fmtCoord(g: GeoFix) {
  const lat = `${Math.abs(g.lat).toFixed(5)}° ${g.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(g.lng).toFixed(5)}° ${g.lng >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lng}`;
}

export const mapUrl = (g: GeoFix) => `https://www.google.com/maps?q=${g.lat},${g.lng}`;

/** Proof photos further than this from the venue pin get flagged. */
export const ONSITE_RADIUS_M = 150;
