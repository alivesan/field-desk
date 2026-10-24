/*
 * Store names without the part every store shares. Stores are entered as "ASUS ROG Exclusive Store —
 * Incredible Technologies"; on a page that lists them all, the same heading on every row says
 * nothing, so screens lead with the short name and show the dropped part once, small.
 * Pure and Node-loadable; stored names are never changed.
 */

/** The known prefix, with its separator, when something follows it. */
const KNOWN = /^ASUS ROG Exclusive Store(?:\s*[—–-]\s*(?=\S)|\s+(?=[^\s—–-]))/i;
/** A separator between the parts of a name: " — ", " – ", " - " (a plain dash needs spaces around it, an em/en dash doesn't). */
const SEP = /\s*[—–]\s*|\s+-\s+/g;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The dropped prefix without its trailing separator: "ASUS ROG Exclusive Store — " → "ASUS ROG Exclusive Store". */
const tidy = (s: string) => s.replace(/\s*[—–-]\s*$/, '').trim();

/** Name parts, each keeping its trailing separator, so joining them gives the name back. */
function parts(name: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const m of name.matchAll(SEP)) {
    const end = m.index! + m[0].length;
    if (m.index! === at) continue; // a separator with nothing before it isn't a part
    out.push(name.slice(at, end));
    at = end;
  }
  out.push(name.slice(at));
  return out.filter((p) => p.trim() !== '');
}

function dropped(name: string, siblingNames: string[]): { prefix: string; short: string } {
  const full = clean(name);
  const known = KNOWN.exec(full);
  const rest = known ? full.slice(known[0].length) : full;
  let prefix = known ? known[0] : '';

  // Whatever leading parts every store of the campaign shares (the last part of each name always stays).
  const mine = parts(rest);
  const all = siblingNames.map((n) => clean(n).replace(KNOWN, '')).filter(Boolean).map(parts);
  if (mine.length > 1 && all.length > 1) {
    let shared = 0;
    while (shared < mine.length - 1 && all.every((p) => p.length > shared + 1 && p[shared].toLowerCase() === mine[shared].toLowerCase())) shared++;
    if (shared > 0) prefix += mine.slice(0, shared).join('');
  }
  const short = full.slice(prefix.length).trim();
  return short ? { prefix: tidy(prefix), short } : { prefix: '', short: full }; // never drop a name to nothing
}

/**
 * The name a store goes by on screen: the known "ASUS ROG Exclusive Store" prefix is dropped, and so is any
 * leading part ("Croma — ") that every store of the campaign shares. `siblingNames` are the campaign's store
 * names (the store's own may be among them); without them only the known prefix goes.
 */
export const storeShortName = (name: string, siblingNames: string[] = []) => dropped(name, siblingNames).short;

/** The part storeShortName dropped ("ASUS ROG Exclusive Store"), or '' when nothing was. */
export const storePrefix = (name: string, siblingNames: string[] = []) => dropped(name, siblingNames).prefix;

/** The names of every store in one campaign, for the two functions above. */
export function campaignStoreNames(stores: Iterable<{ name: string; eventId: string }>, eventId: string): string[] {
  const out: string[] = [];
  for (const s of stores) if (s.eventId === eventId) out.push(s.name);
  return out;
}

/** The prefix that every one of these names has dropped, when it is the same one ("ASUS ROG Exclusive Store" for a whole campaign); else ''. */
export function sharedPrefix(names: string[]): string {
  const first = names.length ? storePrefix(names[0], names) : '';
  return first && names.every((n) => storePrefix(n, names) === first) ? first : '';
}
