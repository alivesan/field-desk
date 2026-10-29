import zlib from 'node:zlib';

/*
 * Zip files with node built-ins only.
 *
 *   readZip(buf)   a reader for small archives held in memory (the .xlsx files HQ's sheet is exported as):
 *                  finds the central directory, inflates entries with zlib.inflateRawSync under a size cap
 *                  and checks each entry's size and CRC. No zip64, no encryption, no spanned archives.
 *   zipChunks(…)   a streaming writer for the print files a store (or the whole week) is downloaded as:
 *                  STORED entries with data descriptors, so the CRC and size are computed while the bytes
 *                  go by and nothing is buffered. The central directory follows at the end.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export interface ZipLimits {
  maxEntries?: number;
  /** Largest an entry may inflate to. */
  maxEntryBytes?: number;
}

export function readZip(buf: Buffer, limits: ZipLimits = {}) {
  const maxEntries = limits.maxEntries ?? 2000;
  const maxEntryBytes = limits.maxEntryBytes ?? 32 * 1024 * 1024;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('Zip64 archives aren’t supported.');
  if (count > maxEntries || cdOffset + cdSize > buf.length) throw new ZipError('The zip file is damaged.');

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip file is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (flags & 1) throw new ZipError('Encrypted zip files aren’t supported.');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, {
      name,
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function read(name: string): Buffer {
    const e = entries.get(name);
    if (!e) throw new ZipError(`No ${name} in the zip file.`);
    if (e.size > maxEntryBytes) throw new ZipError(`${name} is too big.`);
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipError('The zip file is damaged.');
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (start + e.compressedSize > buf.length) throw new ZipError('The zip file is damaged.');
    const raw = buf.subarray(start, start + e.compressedSize);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      } catch {
        throw new ZipError(`${name} couldn’t be unpacked.`);
      }
    } else throw new ZipError(`${name} uses a compression this reader doesn’t know.`);
    if (data.length !== e.size || zlib.crc32(data) !== e.crc) throw new ZipError(`${name} is damaged.`);
    return data;
  }

  return { names: () => [...entries.keys()], has: (name: string) => entries.has(name), entry: (name: string) => entries.get(name), read, text: (name: string) => read(name).toString('utf8') };
}

/* ---------- writer ---------- */

export interface ZipInput {
  /** Path inside the archive, "/" between folders. */
  name: string;
  body: AsyncIterable<Uint8Array> | Uint8Array;
  date?: Date;
}

const U32_MAX = 0xffffffff;

function dosTime(d: Date) {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** The archive as chunks. Throws (ending the stream) if it would need zip64: over 65,534 files or 4 GB. */
export async function* zipChunks(entries: AsyncIterable<ZipInput>, now: () => number = Date.now): AsyncGenerator<Buffer> {
  const done: { name: Buffer; crc: number; size: number; offset: number; time: number; date: number }[] = [];
  let offset = 0;
  for await (const e of entries) {
    if (done.length >= 0xfffe) throw new ZipError('Too many files for one zip.');
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(e.date ?? new Date(now()));
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0808, 6); // bit 3: sizes follow the data; bit 11: UTF-8 name
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt16LE(name.length, 26);
    const entryOffset = offset;
    yield head;
    yield name;
    offset += head.length + name.length;
    let crc = 0;
    let size = 0;
    const parts: AsyncIterable<Uint8Array> = e.body instanceof Uint8Array ? [e.body] as unknown as AsyncIterable<Uint8Array> : e.body;
    for await (const chunk of parts) {
      const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      crc = zlib.crc32(b, crc);
      size += b.length;
      offset += b.length;
      if (size > U32_MAX || offset > U32_MAX) throw new ZipError('Too much data for one zip.');
      yield b;
    }
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(size, 8); // compressed = uncompressed: stored
    dd.writeUInt32LE(size, 12);
    yield dd;
    offset += dd.length;
    done.push({ name, crc, size, offset: entryOffset, time, date });
  }
  const cdStart = offset;
  for (const d of done) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // made by
    c.writeUInt16LE(20, 6); // needed
    c.writeUInt16LE(0x0808, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(d.time, 12);
    c.writeUInt16LE(d.date, 14);
    c.writeUInt32LE(d.crc, 16);
    c.writeUInt32LE(d.size, 20);
    c.writeUInt32LE(d.size, 24);
    c.writeUInt16LE(d.name.length, 28);
    c.writeUInt32LE(d.offset, 42);
    yield c;
    yield d.name;
    offset += c.length + d.name.length;
  }
  if (offset > U32_MAX) throw new ZipError('Too much data for one zip.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(done.length, 8);
  end.writeUInt16LE(done.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  yield end;
}
