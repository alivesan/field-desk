/*
 * Backup import, the safe way: parse and validate the WHOLE file, then build a dry-run plan
 * (what would be created / replaced / kept, what it means for sign-in codes, which photos are
 * missing) — all before a single photo is stored or a record touched. backup.ts applies a plan
 * only after the user confirms it. Pure: no browser APIs, so it is tested under Node.
 */
import type { Admin, AppState, SteamAccount, Store, TournamentEvent } from './types.ts';
import { normalizeStore, validateDocument, type DocKind } from './schema.ts';
import { storeEvidence } from './evidence.ts';
import { sameJson } from './submission.ts';

export const BACKUP_KIND = 'field-desk-backup';
/** 1 = state + photos; 2 adds the evidence manifest (counts, sha256 per photo, complete flag). */
export const BACKUP_FORMAT = 2;

const MAX_PHOTO_CHARS = 30 * 1024 * 1024; // one data URL (≈22 MB of JPEG)
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DATA_URL = /^data:image\/(jpeg|jpg|png|webp|gif|heic|heif);base64,[A-Za-z0-9+/]+={0,2}$/;
const SHA = /^[0-9a-f]{64}$/;

export interface ParsedBackup {
  format: number;
  exportedAt?: string;
  state: { events: Record<string, TournamentEvent>; stores: Record<string, Store>; admins: Record<string, Admin>; accounts: Record<string, SteamAccount> };
  photos: Record<string, string>; // id → data URL
  sha256: Record<string, string>; // id → expected hash, from the manifest (format 2)
  complete?: boolean; // the exporter's own verdict (format 2)
  exportMissing: { id: string; storeId?: string; label: string }[]; // photos the exporter couldn't include
}

export type ParseResult = { ok: true; backup: ParsedBackup } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const okId = (k: string) => k.length > 0 && k.length <= 200 && !BAD_KEYS.has(k);

/** The minimum shape before a record is even worth handing to validateDocument (schema.ts does the full check). */
function basics(kind: DocKind, v: Record<string, unknown>): string[] {
  const p: string[] = [];
  const str = (k: string) => typeof v[k] !== 'string' && p.push(`${k}: must be text`);
  if (kind === 'events') {
    str('name');
    str('date');
    if (!Array.isArray(v.games)) p.push('games: must be a list');
  } else if (kind === 'stores') {
    str('name');
    str('eventId');
    if (!isObj(v.recce)) p.push('recce: missing');
    if (!isObj(v.day)) p.push('day: missing');
  } else if (kind === 'accounts') {
    str('username');
    str('password');
  } else {
    str('name');
    str('code');
  }
  return p;
}

/** Structure only — every problem is collected, nothing is trusted until all of it passes. */
export function parseBackup(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That file isn’t valid JSON — it may be cut off or not a backup at all.'] };
  }
  if (!isObj(data) || data.kind !== BACKUP_KIND) return { ok: false, errors: ['That isn’t a Field Desk backup file.'] };
  const errors: string[] = [];
  const format = data.format === undefined ? 1 : data.format;
  if (format !== 1 && format !== 2) errors.push(`Backup format ${String(format)} is newer than this app understands.`);
  const st = data.state;
  if (!isObj(st) || st.version !== 1) return { ok: false, errors: [...errors, 'state: missing, or from an unsupported version.'] };

  const coll = (kind: DocKind, required: boolean) => {
    const c = st[kind];
    if (c === undefined && !required) return {};
    if (!isObj(c)) {
      errors.push(`state.${kind}: must be an object of records`);
      return {};
    }
    for (const [k, v] of Object.entries(c)) {
      if (!okId(k)) errors.push(`state.${kind}: invalid record id “${k.slice(0, 40)}”`);
      else if (!isObj(v)) errors.push(`${kind}.${k}: must be an object`);
      else if (v.id !== k) errors.push(`${kind}.${k}: id doesn’t match its key`);
      else for (const p of basics(kind, v)) errors.push(`${kind}.${k}.${p}`);
    }
    return c;
  };
  const events = coll('events', true) as Record<string, TournamentEvent>;
  const stores = coll('stores', true) as Record<string, Store>;
  const admins = coll('admins', false) as Record<string, Admin>;
  const accounts = coll('accounts', false) as Record<string, SteamAccount>; // HQ's Steam accounts (passwords included — a backup file is as private as the data)

  const photos: Record<string, string> = {};
  if (data.photos !== undefined && !isObj(data.photos)) errors.push('photos: must be an object of id → image');
  else
    for (const [id, url] of Object.entries((data.photos as Record<string, unknown>) ?? {})) {
      if (!okId(id)) errors.push(`photos: invalid photo id “${id.slice(0, 40)}”`);
      else if (typeof url !== 'string' || url.length > MAX_PHOTO_CHARS || !DATA_URL.test(url)) errors.push(`photos.${id}: not an embedded image`);
      else photos[id] = url;
    }

  const sha256: Record<string, string> = {};
  let complete: boolean | undefined;
  const exportMissing: ParsedBackup['exportMissing'] = [];
  if (data.manifest !== undefined) {
    const m = data.manifest;
    if (!isObj(m)) errors.push('manifest: must be an object');
    else {
      if (typeof m.complete === 'boolean') complete = m.complete;
      if (isObj(m.photos))
        for (const [id, e] of Object.entries(m.photos)) {
          if (isObj(e) && typeof e.sha256 === 'string' && SHA.test(e.sha256)) sha256[id] = e.sha256;
          else errors.push(`manifest.photos.${id.slice(0, 40)}: bad checksum entry`);
        }
      if (Array.isArray(m.missing))
        for (const x of m.missing) if (isObj(x) && typeof x.id === 'string') exportMissing.push({ id: x.id, storeId: typeof x.storeId === 'string' ? x.storeId : undefined, label: typeof x.label === 'string' ? x.label : 'Photo' });
    }
  }
  for (const id of Object.keys(sha256)) if (!photos[id]) errors.push(`manifest lists photo ${id.slice(0, 12)} but the file doesn’t contain it`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, backup: { format: format as number, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : undefined, state: { events, stores, admins, accounts }, photos, sha256, complete, exportMissing } };
}

/* ---------- the plan ---------- */

export interface ImportOptions {
  includeAdmins?: boolean; // default false: sign-in codes in a backup are not restored
  keepNewerLocal?: boolean; // default true: don't overwrite a store this device has a newer copy of
}

export interface KindCounts {
  create: number;
  replace: number;
  same: number; // identical — nothing to do
  keptNewer: number; // local copy is newer, left alone
  skipped: number; // excluded by option (admins)
}

export interface ImportEdit {
  kind: DocKind;
  id: string;
  doc: TournamentEvent | Store | Admin | SteamAccount;
  action: 'create' | 'replace';
}

export interface ImportPlan {
  ok: boolean;
  errors: string[]; // validation failures — when present, `edits` and `photos` are empty
  warnings: string[];
  counts: Record<DocKind, KindCounts>;
  localNewer: { id: string; name: string; local?: string; backup?: string; kept: boolean }[];
  admins: { included: boolean; inFile: number; reactivated: { id: string; name: string; why: string }[] };
  missingPhotos: { id: string; storeId?: string; label: string }[];
  photos: { id: string; storeId: string; data: string; sha256?: string }[]; // to upload before the edits
  edits: ImportEdit[];
}

const zero = (): KindCounts => ({ create: 0, replace: 0, same: 0, keptNewer: 0, skipped: 0 });

export function planImport(b: ParsedBackup, current: AppState, opts: ImportOptions = {}): ImportPlan {
  const includeAdmins = !!opts.includeAdmins;
  const keepNewer = opts.keepNewerLocal !== false;
  const counts: Record<DocKind, KindCounts> = { events: zero(), stores: zero(), admins: zero(), accounts: zero() };
  const warnings: string[] = [];
  const edits: ImportEdit[] = [];
  const localNewer: ImportPlan['localNewer'] = [];
  const reactivated: ImportPlan['admins']['reactivated'] = [];

  const consider = <T extends { id: string }>(kind: DocKind, doc: T, cur: T | undefined) => {
    if (!cur) {
      counts[kind].create++;
      edits.push({ kind, id: doc.id, doc: doc as unknown as ImportEdit['doc'], action: 'create' });
    } else if (sameJson(doc, cur)) counts[kind].same++;
    else {
      counts[kind].replace++;
      edits.push({ kind, id: doc.id, doc: doc as unknown as ImportEdit['doc'], action: 'replace' });
    }
  };

  // Admins first: whether they come in decides what store assignments can point at.
  const adminsAfter: Record<string, Admin> = { ...current.admins };
  const inFile = Object.values(b.state.admins);
  if (includeAdmins) {
    for (const a of inFile) {
      const cur = current.admins[a.id];
      if (!cur) reactivated.push({ id: a.id, name: a.name, why: 'not on this server — their old link would work again' });
      else if (cur.code !== a.code) reactivated.push({ id: a.id, name: a.name, why: 'code differs — the old link would work again and the current one would stop' });
      adminsAfter[a.id] = structuredClone(a);
      consider('admins', a, cur);
    }
  } else counts.admins.skipped = inFile.length;

  // Steam accounts are HQ's own list and come in with the file; stores assigned one need it to exist.
  const accountsAfter: Record<string, SteamAccount> = { ...current.accounts };
  for (const a of Object.values(b.state.accounts)) {
    // The Steam Guard code is the server's alone: a file can't bring one in, and the current one stays.
    const { otp: _stale, ...rest } = a;
    const keep = current.accounts?.[a.id]?.otp;
    const account: SteamAccount = keep ? { ...rest, otp: keep } : rest;
    accountsAfter[a.id] = account;
    consider('accounts', structuredClone(account), current.accounts?.[a.id]);
  }

  const eventsAfter: Record<string, TournamentEvent> = { ...current.events };
  for (const e of Object.values(b.state.events)) {
    eventsAfter[e.id] = e;
    consider('events', structuredClone(e), current.events[e.id]);
  }

  const storesIn: Store[] = [];
  for (const raw of Object.values(b.state.stores)) {
    let s: Store;
    try {
      s = normalizeStore(structuredClone(raw));
    } catch (e) {
      warnings.push(`stores.${raw.id}: couldn’t be read (${(e as Error).message})`);
      continue;
    }
    delete s.steamLogin; // what an admin's copy carries for the store's team — worked out by the server, never saved
    const cur = current.stores[s.id];
    // The team's Steam Guard lookups are the server's alone: a file can't bring any in, and the current ones stay.
    if (cur?.otpState) s.otpState = cur.otpState;
    else delete s.otpState;
    // Submission history is written only by the server — keep what's there; never fabricate revisions.
    const dropped = (s.submissions?.length ?? 0) - (cur?.submissions?.length ?? 0);
    if (cur?.submissions) s.submissions = cur.submissions;
    else delete s.submissions;
    if (dropped > 0) warnings.push(`${s.name}: ${dropped} submitted revision(s) in the backup can’t be restored by import — the working recce is imported, its history stays as on the server`);
    // Tournament state (players / bracket / stations / version) also changes only through server
    // commands — keep the server's; a new store starts with an empty bracket. Check-ins follow the players kept.
    const keptPlayers = cur?.day?.players ?? [];
    if (!sameJson(s.day?.players ?? [], keptPlayers) || !sameJson(s.day?.matches ?? [], cur?.day?.matches ?? [])) {
      if (s.day?.players?.length) warnings.push(`${s.name}: the backup’s match-day bracket (${s.day.players.length} players) can’t be restored by import — ${cur ? 'the bracket stays as on the server' : 'load it again on the match-day page'}`);
    }
    // So is the record of on-the-spot registrations (HQ's Toornament to-do list).
    if (s.day?.onSpot?.length && !sameJson(s.day.onSpot, cur?.day?.onSpot ?? [])) {
      warnings.push(`${s.name}: the backup’s on-the-spot registrations (${s.day.onSpot.length}) can’t be restored by import — ${cur ? 'they stay as on the server' : 'register them again on the match-day page'}`);
    }
    // And the winner / runner-up details (prize details the admin collected).
    if (s.day?.winners && !sameJson(s.day.winners, cur?.day?.winners ?? null)) {
      warnings.push(`${s.name}: the backup’s winner and runner-up details can’t be restored by import — ${cur?.day?.winners ? 'they stay as on the server' : 'collect them again on the match-day page'}`);
    }
    const onSpot = cur?.day?.onSpot;
    const winners = cur?.day?.winners;
    const ids = new Set(keptPlayers.map((p) => p.id));
    s.day = {
      ...s.day,
      players: structuredClone(keptPlayers),
      matches: structuredClone(cur?.day?.matches ?? []),
      stations: cur?.day?.stations ?? s.day?.stations ?? 2,
      version: cur?.day?.version ?? 0,
      checkIn: Object.fromEntries(Object.entries(s.day?.checkIn ?? {}).filter(([pid]) => ids.has(pid))),
    };
    if (onSpot) s.day.onSpot = structuredClone(onSpot);
    else delete s.day.onSpot;
    if (winners) s.day.winners = structuredClone(winners);
    else delete s.day.winners;
    // Assignment: only to an admin that will exist; otherwise keep the current assignment.
    if (s.adminId && !adminsAfter[s.adminId]) {
      const was = s.admin;
      s.adminId = cur?.adminId ?? null;
      s.admin = cur?.admin ?? '';
      warnings.push(`${s.name}: assigned admin “${was || 'unknown'}” isn’t on this server — ${cur?.adminId ? 'keeping the current assignment' : 'left unassigned'}`);
    }
    if (cur && cur.updatedAt && s.updatedAt && cur.updatedAt > s.updatedAt && !sameJson(s, cur)) {
      localNewer.push({ id: s.id, name: s.name, local: cur.updatedAt, backup: s.updatedAt, kept: keepNewer });
      if (keepNewer) {
        counts.stores.keptNewer++;
        continue;
      }
    }
    storesIn.push(s);
    consider('stores', s, cur);
  }

  // Validate every resulting document against the full picture it will live in.
  const errors: string[] = [];
  const ctx = { events: eventsAfter, admins: adminsAfter, accounts: accountsAfter };
  for (const e of edits) {
    if (e.kind === 'stores' && !eventsAfter[(e.doc as Store).eventId]) errors.push(`stores.${e.id}: its campaign (${(e.doc as Store).eventId}) is neither in the file nor on this server`);
    for (const p of validateDocument(e.kind, e.doc, ctx)) errors.push(`${e.kind}.${e.id}: ${p}`);
  }

  // Photos: the ones the imported stores reference. Report what the file lacks.
  const photos: ImportPlan['photos'] = [];
  const missingPhotos: ImportPlan['missingPhotos'] = [];
  const touched = new Set(edits.filter((e) => e.kind === 'stores').map((e) => e.id));
  const known = new Set(Object.values(current.stores).flatMap((s) => storeEvidence(s).map((p) => p.id))); // already referenced here, so already uploaded
  const queued = new Set<string>();
  for (const s of storesIn) {
    if (!touched.has(s.id)) continue;
    for (const p of storeEvidence(s)) {
      if (known.has(p.id) || queued.has(p.id)) continue;
      queued.add(p.id);
      if (b.photos[p.id]) photos.push({ id: p.id, storeId: s.id, data: b.photos[p.id], sha256: b.sha256[p.id] });
      else missingPhotos.push({ id: p.id, storeId: s.id, label: `${s.name} — ${p.section} · ${p.label}` });
    }
  }
  if (b.complete === false) warnings.push(`The exporter marked this backup incomplete (${b.exportMissing.length} photo(s) were missing when it was made).`);

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    counts,
    localNewer,
    admins: { included: includeAdmins, inFile: inFile.length, reactivated },
    missingPhotos,
    photos: ok ? photos : [],
    edits: ok ? edits : [],
  };
}

/** "2 new stores, 1 replaced campaign…" for the confirm button and summary. */
export function planSummary(p: ImportPlan): string {
  const names: Record<DocKind, [string, string]> = { events: ['campaign', 'campaigns'], stores: ['store', 'stores'], admins: ['admin', 'admins'], accounts: ['Steam account', 'Steam accounts'] };
  const parts: string[] = [];
  for (const k of ['events', 'stores', 'admins', 'accounts'] as DocKind[]) {
    const c = p.counts[k];
    const n = (x: number) => names[k][x === 1 ? 0 : 1];
    if (c.create) parts.push(`${c.create} new ${n(c.create)}`);
    if (c.replace) parts.push(`${c.replace} ${n(c.replace)} replaced`);
  }
  return parts.length ? parts.join(', ') : 'Nothing to change — everything in the file is already here';
}
