import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

/*
 * HQ's roster link: fetch a published sheet / CSV on the server (browsers can't, CORS) and hand
 * the text back. HQ-only (server/api.ts), but the server must still never be turned into a probe
 * of its own network, so:
 *
 *   - https only, port 443, no user:pass@;
 *   - Google Sheets edit / share / pubhtml links become their CSV export
 *     (…/export?format=csv&gid=<gid>, …/pub?output=csv) — the sheet must be shared
 *     "Anyone with the link" or "Published to the web", else Google answers with a sign-in page;
 *   - every hop (≤ 5 redirects, followed by hand) is re-checked: the host is resolved and refused
 *     if ANY address is loopback / private / link-local / multicast / unspecified / CGNAT /
 *     reserved, IPv6 ULA / site-local, or an IPv4 one of those mapped or embedded in IPv6
 *     (::ffff:, ::a.b.c.d, 64:ff9b::/96, 2002::/16; Teredo refused outright). The connection
 *     then goes to the address that was checked — no second lookup, so DNS rebinding can't swap
 *     in a private one between check and connect;
 *   - 10 s for the whole thing, ≤ 2 MB, text-like content only;
 *   - optionally (allowHost) only some hosts, on every hop — server/toornament-fetch.ts reuses all
 *     of this for play.toornament.com's JSON, and server/print.ts (via followGuarded) for the creatives
 *     sheet and the Drive files, whose bodies are binary and so are read by the caller.
 *
 * Content types: text/csv, text/plain, text/tab-separated-values, text/comma-separated-values,
 * application/csv, application/json, and text/html (Google serves some published and error pages
 * as HTML, and a few CSV hosts mislabel; the client gets contentType and decides). A missing type,
 * application/octet-stream or application/vnd.ms-excel (servers label .csv files that way) is
 * accepted only if the body looks like text (valid UTF-8, no NUL bytes). Anything else → 415.
 *
 * Errors are RosterFetchError(status, code): 400 bad-url / blocked-host, 413 too-large,
 * 415 unsupported-media, 502 upstream (unreachable, timeout, non-2xx, bad redirect, not shared).
 */

export const ROSTER_MAX_BYTES = 2 * 1024 * 1024;
export const ROSTER_TIMEOUT_MS = 10000;
const MAX_HOPS = 5;

export class RosterFetchError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface LookupAddress {
  address: string;
  family: number;
}
/** One GET to `url`, connecting to the already-checked `addr`. Redirects are not followed. */
export interface HopResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export interface RosterFetchOptions {
  /** DNS: all addresses for a host name. Default dns.promises.lookup(host, { all: true }). */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  /** Transport for one hop. Default: node:https pinned to `addr`. Tests inject a local one. */
  get?: (url: URL, addr: LookupAddress, signal: AbortSignal) => Promise<HopResponse>;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  /** Only these hosts, on the first hop and every redirect (the Toornament fetch: toornament.com only). */
  allowHost?: (host: string) => boolean;
}

/* ---------- addresses ---------- */

function v4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network", incl. 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  );
}

/** Eight 16-bit groups, or null. Accepts ::, a trailing dotted IPv4 and a %zone. */
function v6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  let tail: number[] = [];
  const dot = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dot) {
    const b = v4(dot[2]);
    if (!b) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = dot[1].endsWith('::') ? dot[1] : dot[1].slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x === '' ? [] : x.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const total = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  return [...head, ...Array(8 - total).fill(0), ...rest, ...tail];
}

/** True for any address the server must not fetch from. Unparseable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const four = v4(ip);
  if (four) return blockedV4(four);
  const g = v6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 6).every((x) => x === 0)) return g[6] === 0 ? true : embedded(g[6], g[7]); // ::, ::1, ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: the IPv4 inside is obfuscated — just refuse
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard 100::/64
  return (
    (g[0] & 0xfe00) === 0xfc00 || // ULA fc00::/7
    (g[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g[0] & 0xffc0) === 0xfec0 || // site-local fec0::/10
    (g[0] & 0xff00) === 0xff00 // multicast
  );
}

/* ---------- links ---------- */

/** A Google Sheets link HQ copied from the browser → the URL that returns CSV. Other links unchanged. */
export function sheetsCsvUrl(u: URL): URL {
  if (u.hostname !== 'docs.google.com') return u;
  const hashGid = u.hash.match(/gid=(\d+)/)?.[1];
  const gid = u.searchParams.get('gid') ?? hashGid;
  const pub = u.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/e\/([\w-]+)\/(pubhtml|pub)\/?$/);
  if (pub) {
    const out = new URL(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub`);
    out.searchParams.set('output', 'csv');
    if (gid) out.searchParams.set('gid', gid);
    const single = u.searchParams.get('single');
    if (single) out.searchParams.set('single', single);
    return out;
  }
  const doc = u.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)(\/[^?#]*)?$/);
  if (!doc || doc[1] === 'e') return u;
  if (doc[2]?.startsWith('/export') || doc[2]?.startsWith('/gviz')) return u; // already a data link
  const out = new URL(`https://docs.google.com/spreadsheets/d/${doc[1]}/export`);
  out.searchParams.set('format', 'csv');
  if (gid) out.searchParams.set('gid', gid);
  return out;
}

function checkUrl(u: URL, hop: number, allowHost?: (host: string) => boolean) {
  // On the first hop a bad link is HQ's mistake (400); on a redirect it's the upstream's (502).
  const bad = (msg: string) => (hop ? new RosterFetchError(502, 'upstream', `The link redirected somewhere we won’t follow: ${msg}`) : new RosterFetchError(400, 'bad-url', msg));
  if (u.protocol !== 'https:') throw bad('Only https:// links.');
  if (u.username || u.password) throw bad('Links with a user name or password aren’t allowed.');
  if (u.port && u.port !== '443') throw bad('Only the standard https port.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) throw bad('No host in the link.');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new RosterFetchError(400, 'blocked-host', 'That address is on a private network.');
  if (allowHost && !allowHost(host)) throw bad(`${host} isn’t a site this link may be fetched from.`);
  return host;
}

async function resolveSafe(host: string, lookup: NonNullable<RosterFetchOptions['lookup']>): Promise<LookupAddress> {
  let addrs: LookupAddress[];
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      addrs = await lookup(host);
    } catch {
      throw new RosterFetchError(502, 'upstream', 'Couldn’t find that site — check the link.');
    }
  }
  if (!addrs.length) throw new RosterFetchError(502, 'upstream', 'Couldn’t find that site — check the link.');
  // Refuse if any address is private: the connection could otherwise land on whichever it likes.
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new RosterFetchError(400, 'blocked-host', 'That address is on a private network.');
  return addrs[0];
}

const defaultLookup = (host: string) => dns.promises.lookup(host, { all: true, verbatim: true });

function httpsGet(url: URL, addr: LookupAddress, signal: AbortSignal): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        headers: { 'User-Agent': 'FieldDesk/1 (roster fetch)', Accept: 'text/csv, text/plain;q=0.9, */*;q=0.1' },
        // Connect to the address we checked — never resolve the name a second time.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)) as unknown as typeof dns.lookup,
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, close: () => res.destroy() }),
    );
    req.on('error', reject);
    req.end();
  });
}

const TEXT_TYPES = new Set(['text/csv', 'text/plain', 'text/tab-separated-values', 'text/comma-separated-values', 'application/csv', 'application/json', 'text/html']);
const SNIFF_TYPES = new Set(['', 'application/octet-stream', 'application/vnd.ms-excel']);

export const header = (h: HopResponse['headers'], k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * GETs `start` and follows redirects by hand, checking every hop (see the header). Returns the first 2xx
 * response, body unread, and the URL it came from; anything else is a RosterFetchError.
 */
export async function followGuarded(start: URL, opts: RosterFetchOptions, signal: AbortSignal): Promise<{ res: HopResponse; url: URL }> {
  const lookup = opts.lookup ?? defaultLookup;
  const get = opts.get ?? httpsGet;
  let cur = start;
  for (let hop = 0; ; hop++) {
    // Signing in to Google means the sheet isn't public (said before allowHost can call it an odd redirect).
    if (hop && cur.hostname === 'accounts.google.com') {
      throw new RosterFetchError(502, 'upstream', 'That sheet isn’t public — share it “Anyone with the link” or “Publish to the web”, then try again.', { reason: 'not-shared' });
    }
    const host = checkUrl(cur, hop, opts.allowHost);
    const addr = await resolveSafe(host, lookup);
    let res: HopResponse;
    try {
      res = await get(cur, addr, signal);
    } catch (e) {
      throw upstreamError(e, signal, 'Couldn’t reach that site.');
    }
    const location = header(res.headers, 'location');
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      res.close();
      if (!location) throw new RosterFetchError(502, 'upstream', `The site answered ${res.status} without saying where to.`);
      if (hop >= MAX_HOPS) throw new RosterFetchError(502, 'upstream', 'Too many redirects.');
      try {
        cur = new URL(location, cur);
      } catch {
        throw new RosterFetchError(502, 'upstream', 'The site redirected to a broken link.');
      }
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.close();
      throw new RosterFetchError(502, 'upstream', `The site answered ${res.status}${res.status === 401 || res.status === 403 ? ' — is the sheet shared publicly?' : ''}.`, { status: res.status });
    }
    return { res, url: cur };
  }
}

/** A failure while talking to the site, as a RosterFetchError: timeouts say so. */
export const upstreamError = (e: unknown, signal: AbortSignal, what: string) =>
  e instanceof RosterFetchError ? e : new RosterFetchError(502, 'upstream', signal.aborted ? 'The site took too long to answer.' : what);

/** Fetches a roster link for HQ. See the header comment for every rule. */
export async function fetchRoster(raw: string, opts: RosterFetchOptions = {}) {
  const maxBytes = opts.maxBytes ?? ROSTER_MAX_BYTES;
  const now = opts.now ?? Date.now;
  let cur: URL;
  try {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) throw new Error();
    cur = new URL(raw.trim());
  } catch {
    throw new RosterFetchError(400, 'bad-url', 'That isn’t a link.');
  }
  checkUrl(cur, 0, opts.allowHost);
  cur = sheetsCsvUrl(cur);

  const signal = AbortSignal.timeout(opts.timeoutMs ?? ROSTER_TIMEOUT_MS);
  const upstream = (e: unknown, what: string) => upstreamError(e, signal, what);
  const { res, url } = await followGuarded(cur, opts, signal);
  const contentType = header(res.headers, 'content-type') ?? '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!TEXT_TYPES.has(mime) && !SNIFF_TYPES.has(mime)) {
    res.close();
    throw new RosterFetchError(415, 'unsupported-media', `That link returns ${mime || 'unknown content'}, not a CSV or text list.`);
  }
  const declared = Number(header(res.headers, 'content-length'));
  if (declared > maxBytes) {
    res.close();
    throw new RosterFetchError(413, 'too-large', `That file is over ${Math.round(maxBytes / 1048576)} MB.`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const c of res.body) {
      size += c.length;
      if (size > maxBytes) {
        res.close();
        throw new RosterFetchError(413, 'too-large', `That file is over ${Math.round(maxBytes / 1048576)} MB.`);
      }
      chunks.push(c);
    }
  } catch (e) {
    throw upstream(e, 'The download broke off.');
  }
  const buf = Buffer.concat(chunks);
  let text: string;
  if (SNIFF_TYPES.has(mime)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new RosterFetchError(415, 'unsupported-media', 'That link doesn’t return a text list.');
    }
    if (text.includes('\0')) throw new RosterFetchError(415, 'unsupported-media', 'That link doesn’t return a text list.');
  } else {
    const charset = contentType.match(/charset="?([\w-]+)/i)?.[1];
    let dec: TextDecoder;
    try {
      dec = new TextDecoder(charset ?? 'utf-8');
    } catch {
      dec = new TextDecoder('utf-8');
    }
    text = dec.decode(buf);
  }
  return { url: url.href, contentType, text: text.replace(/^﻿/, ''), fetchedAt: new Date(now()).toISOString() };
}
