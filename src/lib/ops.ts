/*
 * Sync operations, shared by the app and the server (keep this file import-free).
 *
 * An edit is sent as a list of field-level ops — "set stores/abc .recce.network.lan = 'yes'".
 * Devices editing different fields of the same store therefore merge instead of
 * overwriting each other; the same field is last-writer-wins in server order.
 *
 * Collections are merged by identity, not position. An array whose every element is an
 * object with its own unique string `id` (photos, laptops, players, matches…) is "id-keyed":
 *   add      { k, id, p: [...path to array], ins: item, after: prevItemId | null }
 *   remove   { k, id, p: [...path to array], rm: itemId }
 *   update   { k, id, p: [..., { id: itemId }, 'field'], v }   — a selector segment
 * so two devices adding photos both keep theirs, and an edit to laptop L2 still lands on L2
 * after someone else removed L1. Applying is idempotent: inserting an id that is already
 * there, removing one that is gone, or editing through a selector that matches nothing is
 * skipped. Other arrays keep the old rule: equal length → per index, else replaced whole.
 * Ops with numeric indices (the old format) are still applied, for outboxes saved before.
 */

export type DocKind = 'events' | 'stores' | 'admins';
export const DOC_KINDS: DocKind[] = ['events', 'stores', 'admins'];

/** One step of a path: an object key, an array index (old format), or an id selector. */
export type Seg = string | number | { id: string };

export interface Op {
  k: DocKind;
  id: string;
  p: Seg[]; // path inside the doc; [] = the whole doc
  v?: unknown; // value to set
  d?: 1; // delete instead of set
  ins?: { id: string; [key: string]: unknown }; // insert this item into the id-keyed array at p
  after?: string | null; // …right after the item with this id (null = first; gone = at the end)
  rm?: string; // remove the item with this id from the array at p
}

export interface Docs {
  events: Record<string, any>;
  stores: Record<string, any>;
  admins: Record<string, any>;
}

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const clone = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : structuredClone(v));
const isSel = (s: Seg): s is { id: string } => typeof s === 'object' && s !== null;
const itemId = (x: unknown) => (isPlain(x) && typeof x.id === 'string' && x.id ? x.id : null);

/** Every element is an object with a unique non-empty string id. Empty arrays qualify. */
function isIdArray(a: unknown[]) {
  const seen = new Set<string>();
  for (const x of a) {
    const id = itemId(x);
    if (!id || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export function diffDocs(prev: Docs, next: Docs): Op[] {
  const ops: Op[] = [];
  for (const k of DOC_KINDS) {
    const a = prev[k] ?? {};
    const b = next[k] ?? {};
    for (const id of Object.keys(a)) if (!(id in b)) ops.push({ k, id, p: [], d: 1 });
    for (const id of Object.keys(b)) {
      if (!(id in a)) ops.push({ k, id, p: [], v: b[id] });
      else diffValue(a[id], b[id], [], (o) => ops.push({ k, id, ...o }));
    }
  }
  return ops;
}

type Emit = (o: Omit<Op, 'k' | 'id'>) => void;

function diffValue(a: unknown, b: unknown, path: Seg[], emit: Emit) {
  if (a === b) return;
  if (isPlain(a) && isPlain(b)) {
    for (const key of Object.keys(a)) if (a[key] !== undefined && b[key] === undefined) emit({ p: [...path, key], d: 1 });
    for (const key of Object.keys(b)) {
      if (b[key] === undefined) continue;
      if (a[key] === undefined) emit({ p: [...path, key], v: b[key] });
      else diffValue(a[key], b[key], [...path, key], emit);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if ((a.length || b.length) && isIdArray(a) && isIdArray(b)) {
      if (!diffIdArray(a, b, path, emit)) emit({ p: path, v: b }); // reordered: replace whole
      return;
    }
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) diffValue(a[i], b[i], [...path, i], emit);
      return;
    }
  }
  if (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b)) return;
  emit({ p: path, v: b });
}

/** Adds / removes / per-item updates. Returns false (caller replaces the array) if the kept items were reordered. */
function diffIdArray(a: unknown[], b: unknown[], path: Seg[], emit: Emit) {
  const before = new Map(a.map((x) => [itemId(x)!, x]));
  const after = new Set(b.map((x) => itemId(x)!));
  const keptA = a.map((x) => itemId(x)!).filter((id) => after.has(id));
  const keptB = b.map((x) => itemId(x)!).filter((id) => before.has(id));
  if (keptA.some((id, i) => id !== keptB[i])) return false;
  for (const id of before.keys()) if (!after.has(id)) emit({ p: path, rm: id });
  let prev: string | null = null;
  for (const x of b) {
    const id = itemId(x)!;
    if (!before.has(id)) emit({ p: path, ins: x as Op['ins'], after: prev });
    else diffValue(before.get(id), x, [...path, { id }], emit);
    prev = id;
  }
  return true;
}

/**
 * Walks to the container holding the path's last step. Selector steps must match an existing
 * item (else undefined: the op is skipped); plain steps after the last selector are created.
 */
function walk(root: any, path: Seg[]): any {
  const segs = path.slice(0, -1);
  let node = root;
  let lastSel = -1;
  segs.forEach((s, i) => isSel(s) && (lastSel = i));
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (isSel(seg)) {
      if (!Array.isArray(node)) return undefined;
      node = node.find((x) => itemId(x) === seg.id);
      if (!isPlain(node)) return undefined;
      continue;
    }
    let child = node[seg];
    if (typeof child !== 'object' || child === null) {
      if (i < lastSel) return undefined;
      child = node[seg] = typeof path[i + 1] === 'number' ? [] : {};
    }
    node = child;
  }
  return node;
}

/** Applies ops in place. Ops aimed at a doc or item that no longer exists are ignored. */
export function applyOps(docs: Docs, ops: Op[]) {
  for (const op of ops) {
    const coll = (docs[op.k] ??= {});
    if (!op.p.length) {
      if (op.d) delete coll[op.id];
      else if (op.ins === undefined && op.rm === undefined) coll[op.id] = clone(op.v);
      continue;
    }
    const doc = coll[op.id];
    if (typeof doc !== 'object' || doc === null) continue;

    if (op.ins !== undefined || op.rm !== undefined) {
      const parent = walk(doc, op.p);
      const last = op.p[op.p.length - 1];
      if (parent === undefined || isSel(last)) continue;
      let arr = parent[last];
      if (arr == null && op.ins !== undefined) arr = parent[last] = [];
      if (!Array.isArray(arr)) continue;
      if (op.rm !== undefined) {
        const i = arr.findIndex((x) => itemId(x) === op.rm);
        if (i >= 0) arr.splice(i, 1);
      } else if (!arr.some((x) => itemId(x) === op.ins!.id)) {
        const at = op.after == null ? 0 : arr.findIndex((x) => itemId(x) === op.after) + 1;
        arr.splice(op.after != null && at === 0 ? arr.length : at, 0, clone(op.ins));
      }
      continue;
    }

    const last = op.p[op.p.length - 1];
    if (isSel(last)) continue; // replace / delete whole items with ins / rm
    const node = walk(doc, op.p);
    if (node === undefined) continue;
    if (op.d) {
      if (!Array.isArray(node)) delete node[last];
    } else node[last] = clone(op.v);
  }
}

const segKey = (s: Seg) => (isSel(s) ? `#${s.id}` : String(s));

/**
 * Appends ops, dropping earlier *set/delete* ops on exactly the same path (the later one
 * overwrites them anyway). Inserts and removals are never dropped or merged.
 */
export function compactInto(target: Op[], ops: Op[]) {
  const key = (o: Op) => (o.ins !== undefined || o.rm !== undefined ? null : `${o.k}\u0000${o.id}\u0000${o.p.map(segKey).join('\u0000')}`);
  const incoming = new Set(ops.map(key).filter((x) => x !== null));
  const kept = target.filter((o) => {
    const k = key(o);
    return k === null || !incoming.has(k);
  });
  target.length = 0;
  target.push(...kept, ...ops);
}

const ITEM_ID = /^[^\u0000-\u001f]{1,200}$/;

/** Strict shape check for ops arriving over the network. Throws on anything unexpected. */
export function validateOps(input: unknown): Op[] {
  if (!Array.isArray(input) || input.length > 5000) throw new Error('ops must be an array of at most 5000');
  return input.map((o) => {
    if (!isPlain(o)) throw new Error('op must be an object');
    const { k, id, p, v, d, ins, after, rm } = o as Record<string, unknown>;
    if (!DOC_KINDS.includes(k as DocKind)) throw new Error('bad op kind');
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('bad op id');
    if (!Array.isArray(p) || p.length > 32) throw new Error('bad op path');
    const path: Seg[] = p.map((seg) => {
      if (typeof seg === 'string') {
        if (seg.length > 200 || FORBIDDEN.has(seg)) throw new Error('bad path segment');
        return seg;
      }
      if (typeof seg === 'number') {
        if (!Number.isInteger(seg) || seg < 0 || seg > 10000) throw new Error('bad path index');
        return seg;
      }
      if (!isPlain(seg) || Object.keys(seg).length !== 1 || typeof seg.id !== 'string' || !ITEM_ID.test(seg.id)) throw new Error('bad path selector');
      return { id: seg.id };
    });
    const kind = k as DocKind;
    const modes = [v !== undefined || (d === undefined && ins === undefined && rm === undefined), d !== undefined, ins !== undefined, rm !== undefined].filter(Boolean).length;
    if (modes !== 1) throw new Error('an op sets, deletes, inserts or removes — exactly one');

    if (ins !== undefined || rm !== undefined) {
      if (!path.length || isSel(path[path.length - 1])) throw new Error('insert / remove needs the path of an array');
      if (rm !== undefined) {
        if (after !== undefined) throw new Error('bad remove');
        if (typeof rm !== 'string' || !ITEM_ID.test(rm)) throw new Error('bad remove id');
        return { k: kind, id, p: path, rm };
      }
      if (!isPlain(ins) || typeof ins.id !== 'string' || !ITEM_ID.test(ins.id)) throw new Error('insert needs an object with a string id');
      if (Object.keys(ins).some((key) => FORBIDDEN.has(key))) throw new Error('bad insert key');
      if (after !== null && (typeof after !== 'string' || !ITEM_ID.test(after))) throw new Error('insert needs after: an item id or null');
      return { k: kind, id, p: path, ins: ins as Op['ins'], after };
    }
    if (after !== undefined) throw new Error('after is only for inserts');
    if (path.length && isSel(path[path.length - 1])) throw new Error('replace or delete whole items with insert / remove');
    if (d !== undefined && d !== 1) throw new Error('bad delete flag');
    if (!d && path.length === 0 && !isPlain(v)) throw new Error('a whole doc must be an object');
    return d ? { k: kind, id, p: path, d: 1 } : { k: kind, id, p: path, v };
  });
}

/** JSON.parse that drops "__proto__" keys. */
export const safeParse = (text: string) => JSON.parse(text, (key, value) => (key === '__proto__' ? undefined : value));
