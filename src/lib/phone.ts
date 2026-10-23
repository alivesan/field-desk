/*
 * Phone numbers for player check-in, shared by the HQ import, the public check-in page and
 * the server — plus the other bits of a player's identity (public name, in-game name, id).
 * Node-loadable, no imports.
 *
 * Normalized form = digits only. Indian numbers keep their last 10 digits (so "+91 98200 11111",
 * "098200 11111" and "9820011111" match). Anything else keeps all digits.
 */

export function normalizePhone(input: string): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length > 10 && (digits.startsWith('91') || digits.startsWith('0'))) return digits.slice(-10);
  return digits;
}

/** Something a person could type and we'd accept as a phone number. */
export const isPhone = (input: string) => {
  const n = normalizePhone(input);
  return n.length >= 8 && n.length <= 15;
};

/** "•••• •• 1111" — enough for staff to tell two players apart, not enough to copy the number. */
export const maskPhone = (phone: string) => (phone ? `•••• •• ${phone.slice(-4)}` : '');

/** What the public check-in page may say about a player: first name + last initial. */
export function publicName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

/** Longest in-game name kept on a player (Player.ign). */
export const MAX_IGN = 40;

/** An in-game name as stored: spaces collapsed and trimmed ('' = none). Length is checked by the caller. */
export const cleanIgn = (raw: string) => String(raw ?? '').replace(/\s+/g, ' ').trim();

/**
 * A stable player id from the phone (or, without one, the name), so re-importing the same list
 * keeps ids — and with them check-ins. FNV-1a, base36; not a secret, just stable and short.
 */
export function playerIdFor(phone: string | undefined, name: string): string {
  const key = phone ? `t:${normalizePhone(phone)}` : `n:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let h2 = 0x01000193;
  for (let i = key.length - 1; i >= 0; i--) {
    h2 ^= key.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `p${(h >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`.slice(0, 16);
}
