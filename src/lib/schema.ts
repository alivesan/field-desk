/*
 * Domain document validation — used by the server before every commit and by backup import.
 *
 *   validateDocument(kind, doc, ctx?) → list of problems ([] = valid). Messages are human-readable
 *     and start with the JSON path, e.g. "recce.network.speed.down: must be a number ≥ 0".
 *     Items of id-keyed lists are addressed by id ("recce.laptops[id=k3].photos[0].geo"), so a
 *     message stays the same when other items are added or removed.
 *   normalizeStore(store) → the store with legacy shapes upgraded (uses ensureRecce from recce.ts).
 *
 * Unknown extra fields are allowed (newer clients may add some); the fields the app reads are
 * checked for type, range and cross-references. ctx supplies the other collections for
 * referential checks (store.eventId / store.adminId exist, admin codes and stores' self check-in
 * tokens unique); a check is
 * skipped when its collection isn't given.
 *
 * Node-loadable: no browser APIs, explicit .ts imports only.
 */
import type { Admin, Recce, SteamAccount, Store, TournamentEvent } from './types.ts';
import { ensureRecce } from './recce.ts';
import { HH_MM, toornamentLinkProblem } from './toornament.ts';
import { MAX_IGN } from './phone.ts';
import { INSTAGRAM_HANDLE } from './winnerInput.ts';
import { PRINT_KINDS } from './print.ts';

export type DocKind = 'events' | 'stores' | 'admins' | 'accounts';

export interface ValidationContext {
  events?: Record<string, TournamentEvent>;
  admins?: Record<string, Admin>;
  accounts?: Record<string, SteamAccount>;
  /** For cross-store checks (self check-in tokens unique). */
  stores?: Record<string, Store>;
}

/** Document / item ids. */
export const ID = /^[\w-]{1,64}$/;
/** Photo ids — also the on-disk file name, so stricter. */
export const PHOTO_ID = /^[a-z0-9]{6,40}$/;
/** No 0/O, 1/I/L — codes get read out over the phone. Must match ALPHABET in admins.ts. */
export const ADMIN_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
export const MAX_STATIONS = 64;
/** Self check-in token — the only thing in the venue QR (/c/<token>). Must match the client route. */
export const CHECKIN_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
/** The print desk's token — the only thing in its public link (/p/<token>). Same shape as the check-in token. */
export const PRINT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
/** A Google Drive file id (the /file/d/<id>/ part of a share link). */
export const DRIVE_ID = /^[\w-]{20,128}$/;
/** A stored player phone: normalized digits (normalizePhone in phone.ts). */
export const PHONE_DIGITS = /^\d{6,15}$/;

type Rec = Record<string, unknown>;
const isObj = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);

export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const isTime = (v: unknown) => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));

/* ---------- small checkers: each records a problem and returns false ---------- */

function checker(out: string[]) {
  const bad = (path: string, msg: string) => (out.push(`${path || '(document)'}: ${msg}`), false);
  const c = {
    bad,
    obj: (v: unknown, path: string): v is Rec => isObj(v) || bad(path, 'must be an object'),
    list: (v: unknown, path: string, max: number): v is unknown[] =>
      Array.isArray(v) ? v.length <= max || bad(path, `must have at most ${max} items`) : bad(path, 'must be a list'),
    str: (v: unknown, path: string, max = 2000) => (typeof v === 'string' && v.length <= max) || bad(path, `must be text of at most ${max} characters`),
    optStr: (v: unknown, path: string, max = 2000) => v === undefined || c.str(v, path, max),
    bool: (v: unknown, path: string) => typeof v === 'boolean' || bad(path, 'must be true or false'),
    optBool: (v: unknown, path: string) => v === undefined || c.bool(v, path),
    num: (v: unknown, path: string, min: number, max: number, int = false) =>
      (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v))) ||
      bad(path, `must be ${int ? 'a whole number' : 'a number'} ${max === Infinity ? `≥ ${min}` : `${min}–${max}`}`),
    numOrNull: (v: unknown, path: string, min: number, max: number, int = false) => v === null || c.num(v, path, min, max, int),
    oneOf: (v: unknown, path: string, values: readonly unknown[]) => values.includes(v) || bad(path, `must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}`),
    id: (v: unknown, path: string) => (typeof v === 'string' && ID.test(v)) || bad(path, 'must be an id (1–64 letters, digits, _ or -)'),
    date: (v: unknown, path: string) => isDate(v) || bad(path, 'must be a date yyyy-mm-dd'),
    time: (v: unknown, path: string) => isTime(v) || bad(path, 'must be a date-time'),
    optTime: (v: unknown, path: string) => v === undefined || c.time(v, path),
    flags: (v: unknown, path: string) => {
      if (!c.obj(v, path)) return false;
      for (const [k, x] of Object.entries(v)) if (typeof x !== 'boolean') bad(`${path}.${k}`, 'must be true or false');
      return true;
    },
    geo: (v: unknown, path: string) => {
      if (!c.obj(v, path)) return false;
      c.num(v.lat, `${path}.lat`, -90, 90);
      c.num(v.lng, `${path}.lng`, -180, 180);
      c.num(v.accuracy, `${path}.accuracy`, 0, Infinity);
      return true;
    },
    geoOrNull: (v: unknown, path: string) => v === null || c.geo(v, path),
    /** A list of items with ids; returns the items with their stable paths. Duplicate ids are a problem. */
    items: (v: unknown, path: string, max: number, idOk: (id: unknown) => boolean = (id) => typeof id === 'string' && ID.test(id)) => {
      const res: { item: unknown; path: string }[] = [];
      if (!c.list(v, path, max)) return res;
      const seen = new Set<string>();
      v.forEach((item, i) => {
        const id = isObj(item) ? item.id : undefined;
        const ok = idOk(id);
        const p = ok ? `${path}[id=${id}]` : `${path}[${i}]`;
        if (ok && seen.has(id as string)) bad(p, 'duplicate id');
        if (ok) seen.add(id as string);
        res.push({ item, path: p });
      });
      return res;
    },
  };
  return c;
}

type C = ReturnType<typeof checker>;

/* ---------- documents ---------- */

export function validateDocument(kind: DocKind, doc: unknown, ctx: ValidationContext = {}): string[] {
  const out: string[] = [];
  const c = checker(out);
  if (!c.obj(doc, '')) return out;
  if (kind === 'events') validateEvent(c, doc, ctx);
  else if (kind === 'admins') validateAdmin(c, doc, ctx);
  else if (kind === 'accounts') validateAccount(c, doc, ctx);
  else if (kind === 'stores') validateStore(c, doc, ctx);
  else c.bad('', `unknown document kind ${JSON.stringify(kind)}`);
  return out;
}

function validateEvent(c: C, e: Rec, ctx: ValidationContext) {
  c.id(e.id, 'id');
  c.str(e.name, 'name', 200);
  c.date(e.date, 'date');
  for (const k of ['games', 'collateral'] as const) if (c.list(e[k], k, 100)) (e[k] as unknown[]).forEach((g, i) => c.str(g, `${k}[${i}]`, 200));
  c.num(e.gameReadyTarget, 'gameReadyTarget', 0, 1000, true);
  c.num(e.minDownMbps, 'minDownMbps', 0, 1e6);
  c.time(e.createdAt, 'createdAt');
  if (e.storeSheet !== undefined && c.obj(e.storeSheet, 'storeSheet')) {
    c.str(e.storeSheet.url, 'storeSheet.url', 2000);
    c.time(e.storeSheet.fetchedAt, 'storeSheet.fetchedAt');
  }
  if (e.printSheet !== undefined && c.obj(e.printSheet, 'printSheet')) {
    c.str(e.printSheet.url, 'printSheet.url', 2000);
    c.optTime(e.printSheet.importedAt, 'printSheet.importedAt');
  }
  if (e.printDesk !== undefined && c.obj(e.printDesk, 'printDesk')) {
    const token = e.printDesk.token;
    if (typeof token !== 'string' || !PRINT_TOKEN.test(token)) c.bad('printDesk.token', 'must be 16–64 letters, digits, _ or -');
    else if (ctx.events && Object.values(ctx.events).some((o) => o && o.id !== e.id && o.printDesk?.token === token)) c.bad('printDesk.token', 'is already used by another campaign');
    c.time(e.printDesk.createdAt, 'printDesk.createdAt');
  }
  if (e.printSpec !== undefined && c.obj(e.printSpec, 'printSpec')) {
    for (const [k, v] of Object.entries(e.printSpec)) {
      if (!c.oneOf(k, `printSpec.${k}`, PRINT_KINDS) || !c.obj(v, `printSpec.${k}`)) continue;
      if (typeof v.size !== 'string' || !v.size.trim() || v.size.length > 60) c.bad(`printSpec.${k}.size`, 'must be text of 1–60 characters');
      c.num(v.qty, `printSpec.${k}.qty`, 1, 100000, true);
    }
  }
  if (e.toornamentAuto !== undefined && c.obj(e.toornamentAuto, 'toornamentAuto')) {
    if (typeof e.toornamentAuto.from !== 'string' || !HH_MM.test(e.toornamentAuto.from)) c.bad('toornamentAuto.from', 'must be a time of day, HH:MM (24-hour)');
  }
}

function validateAdmin(c: C, a: Rec, ctx: ValidationContext) {
  c.id(a.id, 'id');
  c.str(a.name, 'name', 200);
  c.str(a.phone, 'phone', 100);
  if (typeof a.code !== 'string' || !ADMIN_CODE.test(a.code)) c.bad('code', 'must be 4 characters: A–Z and 2–9, without 0/O/1/I/L');
  else if (ctx.admins && Object.values(ctx.admins).some((o) => o && o.id !== a.id && o.code === a.code)) c.bad('code', 'is already used by another admin');
  else if (ctx.stores && Object.values(ctx.stores).some((o) => o?.access?.code === a.code)) c.bad('code', 'is already used by a store team link');
  c.time(a.createdAt, 'createdAt');
}

/** A Steam account of HQ's. Login fields are required and plain text; the username is unique in the list (case aside). */
function validateAccount(c: C, a: Rec, ctx: ValidationContext) {
  c.id(a.id, 'id');
  c.optStr(a.label, 'label', 200);
  for (const k of ['username', 'password'] as const) {
    if (typeof a[k] !== 'string' || !(a[k] as string).trim()) c.bad(k, 'must be text (up to 200 characters), not empty');
    else c.str(a[k], k, 200);
  }
  c.optStr(a.email, 'email', 200);
  c.optStr(a.notes, 'notes', 2000);
  c.time(a.createdAt, 'createdAt');
  const name = typeof a.username === 'string' ? a.username.trim().toLowerCase() : '';
  if (name && ctx.accounts && Object.values(ctx.accounts).some((o) => o && o.id !== a.id && typeof o.username === 'string' && o.username.trim().toLowerCase() === name)) c.bad('username', 'is already in the Steam accounts list');
}

function validateStore(c: C, s: Rec, ctx: ValidationContext) {
  c.id(s.id, 'id');
  if (c.id(s.eventId, 'eventId') && ctx.events && !ctx.events[s.eventId as string]) c.bad('eventId', `campaign ${s.eventId} doesn’t exist`);
  c.str(s.name, 'name', 200);
  c.str(s.city, 'city', 200);
  c.optStr(s.state, 'state', 200);
  c.optBool(s.exclusive, 'exclusive');
  c.str(s.address, 'address', 1000);
  if (s.date !== undefined && s.date !== '') c.date(s.date, 'date'); // '' / absent = the campaign's date
  c.optStr(s.phone, 'phone', 100);
  if (s.access !== undefined && c.obj(s.access, 'access')) {
    const a = s.access as Record<string, unknown>;
    if (typeof a.code !== 'string' || !ADMIN_CODE.test(a.code)) c.bad('access.code', 'must be 4 characters: A–Z and 2–9, without 0/O/1/I/L');
    c.time(a.createdAt, 'access.createdAt');
    if (typeof a.code === 'string' && ctx.admins && Object.values(ctx.admins).some((o) => o?.code === a.code)) c.bad('access.code', 'is already used by an admin');
    else if (typeof a.code === 'string' && ctx.stores && Object.values(ctx.stores).some((o) => o && o.id !== s.id && o.access?.code === a.code)) c.bad('access.code', 'is already used by another store');
  }
  if (s.steam !== undefined && c.obj(s.steam, 'steam')) {
    const st = s.steam;
    if (c.id(st.accountId, 'steam.accountId') && ctx.accounts && !ctx.accounts[st.accountId as string]) c.bad('steam.accountId', `Steam account ${st.accountId} doesn’t exist`);
    c.oneOf(st.purpose, 'steam.purpose', ['play', 'download']);
    c.time(st.assignedAt, 'steam.assignedAt');
  }
  if (s.steamLogin !== undefined) c.bad('steamLogin', 'is worked out by the server for the store’s team — it can’t be saved');
  c.optStr(s.mapsUrl, 'mapsUrl', 2000);
  c.optStr(s.venue, 'venue', 500);
  if (s.geo !== undefined) c.geoOrNull(s.geo, 'geo');
  if (s.adminId !== undefined && s.adminId !== null && c.id(s.adminId, 'adminId') && ctx.admins && !ctx.admins[s.adminId as string]) {
    c.bad('adminId', `admin ${s.adminId} doesn’t exist`);
  }
  c.str(s.admin, 'admin', 200);
  c.geoOrNull(s.pin, 'pin');
  validateRecce(c, s.recce, 'recce');
  validateDay(c, s.day, 'day');
  const token = isObj(s.day) && isObj(s.day.selfCheckIn) ? s.day.selfCheckIn.token : undefined;
  if (typeof token === 'string' && ctx.stores && Object.values(ctx.stores).some((o) => o && o.id !== s.id && o.day?.selfCheckIn?.token === token)) {
    c.bad('day.selfCheckIn.token', 'is already used by another store');
  }
  if (s.roster !== undefined && c.obj(s.roster, 'roster')) {
    const r = s.roster;
    c.oneOf(r.kind, 'roster.kind', ['upload', 'link', 'paste']);
    c.optStr(r.url, 'roster.url', 2000);
    c.optStr(r.fileName, 'roster.fileName', 500);
    c.time(r.fetchedAt, 'roster.fetchedAt');
    c.num(r.rows, 'roster.rows', 0, 100000, true);
    c.str(r.by, 'roster.by', 100);
  }
  if (s.toornament !== undefined && c.obj(s.toornament, 'toornament')) {
    const t = s.toornament;
    if (c.str(t.url, 'toornament.url', 2000)) {
      const problem = (t.url as string).trim() ? toornamentLinkProblem(t.url as string) : 'it is empty';
      if (problem) c.bad('toornament.url', `must be a toornament.com tournament link (${problem})`);
    }
    if (t.stageId !== undefined && (typeof t.stageId !== 'string' || !/^\d{1,24}$/.test(t.stageId))) c.bad('toornament.stageId', 'must be a Toornament stage id (digits)');
    c.optStr(t.stageName, 'toornament.stageName', 200);
    c.optTime(t.appliedAt, 'toornament.appliedAt');
    c.optStr(t.by, 'toornament.by', 100);
    c.optStr(t.loadId, 'toornament.loadId', 64);
    if (t.auto !== undefined && c.obj(t.auto, 'toornament.auto')) {
      const a = t.auto;
      c.bool(a.enabled, 'toornament.auto.enabled');
      c.optTime(a.lastCheckAt, 'toornament.auto.lastCheckAt');
      if (a.lastResult !== undefined) c.oneOf(a.lastResult, 'toornament.auto.lastResult', ['waiting', 'not-placed', 'applied', 'skipped-underway', 'skipped-manual', 'error']);
      c.optStr(a.message, 'toornament.auto.message', 400);
      c.optTime(a.appliedAt, 'toornament.auto.appliedAt');
    }
  }
  if (s.print !== undefined && c.obj(s.print, 'print')) {
    const seen = new Set<unknown>();
    if (c.list(s.print.files, 'print.files', PRINT_KINDS.length)) {
      (s.print.files as unknown[]).forEach((f, i) => {
        const p = `print.files[${i}]`;
        if (!c.obj(f, p)) return;
        if (c.oneOf(f.kind, `${p}.kind`, PRINT_KINDS)) {
          if (seen.has(f.kind)) c.bad(`${p}.kind`, 'is listed twice');
          seen.add(f.kind);
        }
        if (typeof f.driveId !== 'string' || !DRIVE_ID.test(f.driveId)) c.bad(`${p}.driveId`, 'must be a Google Drive file id');
        if (typeof f.url !== 'string' || f.url.length > 500 || !/^https:\/\/(?:drive|docs)\.google\.com\/\S+$/.test(f.url)) c.bad(`${p}.url`, 'must be a Google Drive link (https://drive.google.com/…) of at most 500 characters');
        c.optStr(f.name, `${p}.name`, 300);
      });
    }
    c.optStr(s.print.tab, 'print.tab', 100);
    c.optStr(s.print.label, 'print.label', 300);
    c.time(s.print.importedAt, 'print.importedAt');
  }
  if (s.printDownloads !== undefined && c.obj(s.printDownloads, 'printDownloads')) {
    for (const [k, v] of Object.entries(s.printDownloads)) {
      if (!c.oneOf(k, `printDownloads.${k}`, PRINT_KINDS) || !c.obj(v, `printDownloads.${k}`)) continue;
      c.time(v.at, `printDownloads.${k}.at`);
      c.str(v.by, `printDownloads.${k}.by`, 120);
    }
  }
  c.optTime(s.updatedAt, 'updatedAt');
  if (s.submissions !== undefined) {
    const revs = new Set<number>();
    for (const { item, path } of c.items(s.submissions, 'submissions', 500)) {
      if (!c.obj(item, path)) continue;
      c.id(item.id, `${path}.id`);
      if (c.num(item.rev, `${path}.rev`, 1, 1e6, true)) {
        if (revs.has(item.rev as number)) c.bad(`${path}.rev`, 'duplicate revision number');
        revs.add(item.rev as number);
      }
      c.time(item.submittedAt, `${path}.submittedAt`);
      c.str(item.by, `${path}.by`, 100);
      c.str(item.byName, `${path}.byName`, 200);
      validateRecce(c, item.recce, `${path}.recce`);
      if (c.obj(item.policy, `${path}.policy`)) {
        const p = item.policy;
        if (c.list(p.games, `${path}.policy.games`, 100)) (p.games as unknown[]).forEach((g, i) => c.str(g, `${path}.policy.games[${i}]`, 200));
        c.num(p.gameReadyTarget, `${path}.policy.gameReadyTarget`, 0, 1000, true);
        c.num(p.minDownMbps, `${path}.policy.minDownMbps`, 0, 1e6);
      }
      c.optTime(item.reviewedAt, `${path}.reviewedAt`);
      c.optStr(item.reviewedBy, `${path}.reviewedBy`, 200);
    }
  }
}

function validatePhotos(c: C, v: unknown, path: string) {
  for (const { item, path: p } of c.items(v, path, 200, (id) => typeof id === 'string' && PHOTO_ID.test(id))) {
    if (!c.obj(item, p)) continue;
    if (typeof item.id !== 'string' || !PHOTO_ID.test(item.id)) c.bad(`${p}.id`, 'must be a photo id (6–40 lowercase letters and digits)');
    c.str(item.label, `${p}.label`, 200);
    c.time(item.takenAt, `${p}.takenAt`);
    c.time(item.fileTime, `${p}.fileTime`);
    c.bool(item.live, `${p}.live`);
    if (item.source !== undefined) c.oneOf(item.source, `${p}.source`, ['camera', 'upload']);
    c.optStr(item.shotAt, `${p}.shotAt`, 64);
    c.geoOrNull(item.geo, `${p}.geo`);
    if (item.geoFrom !== undefined) c.oneOf(item.geoFrom, `${p}.geoFrom`, ['device', 'photo']);
    c.optTime(item.geoAt, `${p}.geoAt`);
    c.optStr(item.geoError, `${p}.geoError`, 500);
  }
}

const YES_NO = ['yes', 'no', null] as const;

function validateRecce(c: C, r: unknown, path: string) {
  if (!c.obj(r, path)) return;
  c.oneOf(r.status, `${path}.status`, ['draft', 'submitted']);
  c.optTime(r.startedAt, `${path}.startedAt`);
  c.optTime(r.submittedAt, `${path}.submittedAt`);

  if (c.obj(r.venue, `${path}.venue`)) {
    validatePhotos(c, r.venue.photos, `${path}.venue.photos`);
    c.optStr(r.venue.area, `${path}.venue.area`, 500);
    c.optStr(r.venue.notes, `${path}.venue.notes`, 5000);
  }

  for (const { item: l, path: p } of c.items(r.laptops, `${path}.laptops`, 200)) {
    if (!c.obj(l, p)) continue;
    c.id(l.id, `${p}.id`);
    c.str(l.label, `${p}.label`, 100);
    c.oneOf(l.role, `${p}.role`, ['game', 'admin', 'spare']);
    c.flags(l.games, `${p}.games`);
    if (l.launched !== undefined) c.flags(l.launched, `${p}.launched`);
    c.bool(l.drivers, `${p}.drivers`);
    c.bool(l.windows, `${p}.windows`);
    c.str(l.notes, `${p}.notes`, 5000);
    validatePhotos(c, l.photos, `${p}.photos`);
  }

  const n = r.network;
  if (c.obj(n, `${path}.network`)) {
    c.oneOf(n.wifi, `${path}.network.wifi`, YES_NO);
    c.oneOf(n.lan, `${path}.network.lan`, YES_NO);
    if (n.speed !== null && c.obj(n.speed, `${path}.network.speed`)) {
      const sp = n.speed;
      for (const k of ['down', 'up', 'ping']) c.numOrNull(sp[k], `${path}.network.speed.${k}`, 0, 1e6);
      c.oneOf(sp.method, `${path}.network.speed.method`, ['auto', 'manual']);
      c.time(sp.at, `${path}.network.speed.at`);
      c.optStr(sp.server, `${path}.network.speed.server`, 200);
    }
    validatePhotos(c, n.photos, `${path}.network.photos`);
    c.optStr(n.ssid, `${path}.network.ssid`, 200);
  }

  const f = r.furniture;
  if (c.obj(f, `${path}.furniture`)) {
    c.oneOf(f.setup, `${path}.furniture.setup`, ['none', 'standard', 'rog', null]);
    c.str(f.chairType, `${path}.furniture.chairType`, 200);
    c.numOrNull(f.chairCount, `${path}.furniture.chairCount`, 0, 10000, true);
    c.oneOf(f.tablecloth, `${path}.furniture.tablecloth`, YES_NO);
    validatePhotos(c, f.photos, `${path}.furniture.photos`);
  }

  const k = r.collateral;
  if (c.obj(k, `${path}.collateral`)) {
    for (const x of ['posters', 'standee', 'cheque', 'chequeInStandeePhoto']) c.bool(k[x], `${path}.collateral.${x}`);
    validatePhotos(c, k.standeePhotos, `${path}.collateral.standeePhotos`);
    validatePhotos(c, k.chequePhotos, `${path}.collateral.chequePhotos`);
    if (k.placed !== undefined) c.flags(k.placed, `${path}.collateral.placed`);
    c.optStr(k.handedTo, `${path}.collateral.handedTo`, 200);
    if (k.photos !== undefined) validatePhotos(c, k.photos, `${path}.collateral.photos`);
  }

  c.str(r.summary, `${path}.summary`, 20000);
}

function validateDay(c: C, d: unknown, path: string) {
  if (!c.obj(d, path)) return;
  const stationsOk = c.num(d.stations, `${path}.stations`, 1, MAX_STATIONS, true);
  if (d.version !== undefined) c.num(d.version, `${path}.version`, 0, Number.MAX_SAFE_INTEGER, true);

  const players = new Set<string>();
  for (const { item: p, path: pp } of c.items(d.players, `${path}.players`, 512)) {
    if (!c.obj(p, pp)) continue;
    if (c.id(p.id, `${pp}.id`)) players.add(p.id as string);
    c.str(p.name, `${pp}.name`, 200);
    c.num(p.seed, `${pp}.seed`, 0, 100000);
    if (p.phone !== undefined && (typeof p.phone !== 'string' || !PHONE_DIGITS.test(p.phone))) c.bad(`${pp}.phone`, 'must be 6–15 digits');
    c.optStr(p.ign, `${pp}.ign`, MAX_IGN);
    if (p.phoneEnd !== undefined && (typeof p.phoneEnd !== 'string' || !/^\d{4}$/.test(p.phoneEnd))) c.bad(`${pp}.phoneEnd`, 'must be 4 digits');
  }

  if (c.obj(d.checkIn, `${path}.checkIn`)) {
    for (const [pid, at] of Object.entries(d.checkIn)) {
      if (!players.has(pid)) c.bad(`${path}.checkIn.${pid}`, 'isn’t a player in this tournament');
      c.time(at, `${path}.checkIn.${pid}`);
    }
  }
  if (d.checkInSource !== undefined && c.obj(d.checkInSource, `${path}.checkInSource`)) {
    for (const [pid, src] of Object.entries(d.checkInSource)) {
      if (!players.has(pid)) c.bad(`${path}.checkInSource.${pid}`, 'isn’t a player in this tournament');
      c.oneOf(src, `${path}.checkInSource.${pid}`, ['self', 'staff']);
    }
  }
  // On-the-spot registrations: a record, so playerId may name someone HQ has since replaced.
  if (d.onSpot !== undefined) {
    for (const { item: e, path: ep } of c.items(d.onSpot, `${path}.onSpot`, 256)) {
      if (!c.obj(e, ep)) continue;
      c.id(e.id, `${ep}.id`);
      c.id(e.playerId, `${ep}.playerId`);
      if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 200) c.bad(`${ep}.name`, 'must be a name of at most 200 characters');
      if (e.phone !== undefined && (typeof e.phone !== 'string' || !PHONE_DIGITS.test(e.phone))) c.bad(`${ep}.phone`, 'must be 6–15 digits');
      c.optStr(e.ign, `${ep}.ign`, MAX_IGN);
      c.time(e.at, `${ep}.at`);
      c.str(e.by, `${ep}.by`, 200);
      c.optTime(e.toornament, `${ep}.toornament`);
    }
  }
  // Winner + runner-up details: playerId may name someone HQ has since replaced (the record is kept across resets).
  if (d.winners !== undefined) {
    const wp = `${path}.winners`;
    if (c.obj(d.winners, wp)) {
      for (const side of ['winner', 'runnerUp'] as const) {
        const w = d.winners[side];
        const sp = `${wp}.${side}`;
        if (!c.obj(w, sp)) continue;
        c.id(w.playerId, `${sp}.playerId`);
        c.str(w.realName, `${sp}.realName`, 100);
        c.optStr(w.ign, `${sp}.ign`, MAX_IGN);
        if (w.phone !== undefined && (typeof w.phone !== 'string' || !PHONE_DIGITS.test(w.phone))) c.bad(`${sp}.phone`, 'must be 6–15 digits');
        c.optStr(w.email, `${sp}.email`, 200);
        if (w.instagram !== undefined && (typeof w.instagram !== 'string' || !INSTAGRAM_HANDLE.test(w.instagram))) c.bad(`${sp}.instagram`, 'must be a handle of letters, digits, “.” and “_” (up to 30)');
      }
      c.id(d.winners.finalMatchId, `${wp}.finalMatchId`);
      c.time(d.winners.at, `${wp}.at`);
      c.time(d.winners.updatedAt, `${wp}.updatedAt`);
      c.str(d.winners.by, `${wp}.by`, 200);
    }
  }
  if (d.selfCheckIn !== undefined && c.obj(d.selfCheckIn, `${path}.selfCheckIn`)) {
    const q = d.selfCheckIn;
    if (typeof q.token !== 'string' || !CHECKIN_TOKEN.test(q.token)) c.bad(`${path}.selfCheckIn.token`, 'must be 16–64 letters, digits, _ or -');
    c.bool(q.open, `${path}.selfCheckIn.open`);
    c.optTime(q.openedAt, `${path}.selfCheckIn.openedAt`);
  }

  const liveStation = new Map<number, string>();
  const livePlayer = new Map<string, string>();
  for (const { item: m, path: mp } of c.items(d.matches, `${path}.matches`, 1024)) {
    if (!c.obj(m, mp)) continue;
    c.id(m.id, `${mp}.id`);
    c.num(m.round, `${mp}.round`, 0, 30, true);
    c.num(m.index, `${mp}.index`, 0, 1 << 20, true);
    // Optional fields may be absent (handlers delete keys): winner, station, startedAt, endedAt, bye, walkover.
    for (const side of ['a', 'b'] as const) {
      const v = m[side];
      if (v != null && (typeof v !== 'string' || !players.has(v))) c.bad(`${mp}.${side}`, 'must be a player in this tournament or null');
    }
    if (m.a != null && m.a === m.b) c.bad(mp, 'a player can’t play themselves');
    if (m.winner != null && (typeof m.winner !== 'string' || (m.winner !== m.a && m.winner !== m.b))) c.bad(`${mp}.winner`, 'must be one of the match’s two players or null');
    c.oneOf(m.status, `${mp}.status`, ['pending', 'live', 'done']);
    c.optBool(m.bye, `${mp}.bye`);
    c.optBool(m.walkover, `${mp}.walkover`);
    if (m.station !== undefined && m.station !== null) c.num(m.station, `${mp}.station`, 1, MAX_STATIONS, true);
    c.optStr(m.score, `${mp}.score`, 200);
    c.optTime(m.startedAt, `${mp}.startedAt`);
    c.optTime(m.endedAt, `${mp}.endedAt`);

    if (m.status === 'live') {
      if (!m.a || !m.b) c.bad(mp, 'a live match needs both players');
      const st = m.station;
      if (typeof st !== 'number' || !Number.isInteger(st)) c.bad(`${mp}.station`, 'a live match needs a station');
      else {
        if (stationsOk && (st < 1 || st > (d.stations as number))) c.bad(`${mp}.station`, `must be within 1–${d.stations}`);
        const other = liveStation.get(st);
        if (other) c.bad(`${mp}.station`, `station ${st} is already playing match ${other}`);
        else liveStation.set(st, String(m.id));
      }
      for (const pid of [m.a, m.b]) {
        if (typeof pid !== 'string') continue;
        const other = livePlayer.get(pid);
        if (other) c.bad(mp, `player ${pid} is already playing match ${other}`);
        else livePlayer.set(pid, String(m.id));
      }
    }
  }
}

/* ---------- legacy upgrade ---------- */

const emptyDay = () => ({ players: [], checkIn: {}, matches: [], stations: 2, version: 0 });

/**
 * Upgrades older store shapes to the current one: fills fields added since (recce sections,
 * collateral checklist, day.version, pin…). Mutates and returns `store`; only ever adds or maps
 * data, never drops any. Safe to run repeatedly.
 */
export function normalizeStore(store: Store): Store {
  const s = store as Store & Rec;
  s.name ??= '';
  s.city ??= '';
  s.address ??= '';
  s.admin ??= '';
  if (s.adminId === undefined) s.adminId = null;
  s.pin ??= null;
  if (!isObj(s.recce)) s.recce = { status: 'draft' } as Recce;
  s.recce.status ??= 'draft';
  ensureRecce(s.recce);
  if (!isObj(s.day)) s.day = emptyDay();
  const d = s.day;
  d.players ??= [];
  d.checkIn ??= {};
  d.matches ??= [];
  d.stations ??= 2;
  d.version ??= 0;
  // Seeded so staff edits and the server's 'self' entries are both per-player paths, never a whole-object write.
  d.checkInSource ??= {};
  if (Array.isArray(s.submissions)) for (const sub of s.submissions) if (isObj(sub) && isObj(sub.recce)) ensureRecce(sub.recce);
  return s;
}
