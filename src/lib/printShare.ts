import type { PrintKind } from './types.ts';

/*
 * Print files — the words and links the screens share: what "Send to print shop" says, what a
 * shared file says, how a download is named when the server's header is all we have. Pure and
 * Node-loadable (no db.ts, no browser globals): the public print desk page uses it too.
 */

/** One file as the screens show it: label, print size, copies. */
export interface PrintRow {
  kind: PrintKind;
  label: string;
  size: string;
  qty: number;
}

/** Public Drive thumbnail (the files are "Anyone with the link"). */
export const driveThumb = (driveId: string, width = 400) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveId)}&sz=w${width}`;

/** The Drive page of a file, for when a link is all that can be shared. */
export const driveView = (driveId: string) => `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/view`;

/** "1 piece" · "10 copies" · "2 pieces". Posters and pamphlets are copies; the standee and cheques are pieces. */
export function copiesText(kind: PrintKind, qty: number) {
  if (qty === 1) return '1 piece';
  return `${qty} ${kind === 'poster' || kind === 'pamphlet' ? 'copies' : 'pieces'}`;
}

/** "6 × 3 ft · 1 piece" — the print instruction on a card. */
export const specLine = (r: PrintRow) => `${r.size} · ${copiesText(r.kind, r.qty)}`;

/** The text that goes with one shared file: "A3 Poster (A3, 297 × 420 mm) — San Infotech — print 10". A size that has its own brackets is folded in, not nested. */
export const fileShareText = (r: PrintRow, storeName: string) => `${r.label} (${r.size.replace(/\s*\((.*)\)\s*$/, ', $1')}) — ${storeName} — print ${r.qty}`;

/**
 * "Send to print shop": every file with its size, copies and Drive link, as one message. The links
 * are the originals, so nothing is compressed on the way (WhatsApp compresses photos it is handed
 * directly, but not a link's file).
 */
export function printShopText(storeName: string, rows: (PrintRow & { link: string })[]) {
  const lines = rows.map((r, i) => `${i + 1}. ${r.label} — ${r.size} — print ${r.qty}\n${r.link}`);
  return [`Print order for ${storeName}`, '', ...lines.flatMap((l, i) => (i ? ['', l] : [l])), '', 'These are the original files — please print from them as they are.'].join('\n');
}

/** The file name in a Content-Disposition header (filename*=UTF-8''… wins over filename="…"), or '' when there is none. */
export function dispositionName(header: string | null | undefined) {
  if (!header) return '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  return (plain?.[1] ?? plain?.[2] ?? '').trim();
}

/** Who saved a file, as written on the store: the person and their team — "Rhea (San Infotech team)". */
export function downloadedBy(name: string | undefined, team: string | undefined) {
  const person = (name ?? '').trim();
  if (team) return person && person !== team ? `${person} (${team} team)` : `${team} team`;
  return person || 'HQ';
}
