import type { GeoFix } from './types.ts';

/*
 * Minimal JPEG EXIF reader: capture time and GPS, for photos uploaded from a GPS-camera
 * app. Best effort — some phones strip location from photos picked in the browser, so
 * a missing result is normal; the camera app's own burned-in stamp is still visible.
 */
export async function readExif(file: Blob): Promise<{ shotAt?: string; geo?: GeoFix }> {
  try {
    const v = new DataView(await file.slice(0, 512 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      off += 2 + v.getUint16(off + 2);
    }
  } catch {
    /* unreadable — treat as no EXIF */
  }
  return {};
}

interface Tag {
  type: number;
  count: number;
  at: number; // offset of the value field, relative to the TIFF header
}

function parseTiff(v: DataView, base: number) {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (o: number) => v.getUint16(base + o, le);
  const u32 = (o: number) => v.getUint32(base + o, le);
  const ifd = (o: number) => {
    const tags = new Map<number, Tag>();
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return tags;
  };
  const ascii = (t?: Tag) => {
    if (!t) return '';
    const o = t.count > 4 ? u32(t.at) : t.at;
    let s = '';
    for (let i = 0; i < t.count; i++) {
      const c = v.getUint8(base + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const rationals = (t?: Tag) => {
    if (!t) return [];
    const o = u32(t.at);
    return Array.from({ length: t.count }, (_, i) => u32(o + i * 8) / (u32(o + i * 8 + 4) || 1));
  };

  const out: { shotAt?: string; geo?: GeoFix } = {};
  const ifd0 = ifd(u32(4));

  const exifPtr = ifd0.get(0x8769);
  const exif = exifPtr ? ifd(u32(exifPtr.at)) : null;
  const stamp = ascii(exif?.get(0x9003)) || ascii(exif?.get(0x9004)) || ascii(ifd0.get(0x0132));
  const m = stamp.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const offset = ascii(exif?.get(0x9011)); // "+05:30", when the camera wrote one
    const d = /^[+-]\d{2}:\d{2}$/.test(offset) ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (!Number.isNaN(d.getTime())) out.shotAt = d.toISOString();
  }

  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const gps = ifd(u32(gpsPtr.at));
    const dms = (r: number[]) => (r.length === 3 ? r[0] + r[1] / 60 + r[2] / 3600 : NaN);
    let lat = dms(rationals(gps.get(2)));
    let lng = dms(rationals(gps.get(4)));
    if (ascii(gps.get(1)) === 'S') lat = -lat;
    if (ascii(gps.get(3)) === 'W') lng = -lng;
    if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) out.geo = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), accuracy: 0 };
  }
  return out;
}
