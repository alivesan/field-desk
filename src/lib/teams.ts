import type { AppState, Store } from './types.ts';

/*
 * Store teams: one sign-in code per store, shared by the 2–4 people who work it (Store.access).
 * Pure helpers shared by the server (who the actor is, which codes are taken) and the app (the
 * team link, the name screen). Nothing here touches the browser or the network.
 */

/** "ASUS ROG Exclusive Store — San Infotech" → "San Infotech". A name that is only the prefix stays whole. */
export function shortStoreName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  const rest = n.replace(/^(?:asus\s+)?(?:rog\s+)?(?:exclusive\s+)?store\s*[—–:-]\s*/i, '').trim();
  return (rest || n).slice(0, 40).trim() || 'Store';
}

/** The name a person types on the first sign-in: no brackets (they'd fake the team part), no control characters, ≤ 40 characters. */
export function cleanPersonName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f<>()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
}

/**
 * What gets recorded as "by" for someone on a store team: the person, with the team beside
 * them so HQ can tell it wasn't a personal admin — "Rhea (San Infotech team)". Until they've
 * typed a name it is just "San Infotech team".
 */
export const teamActorName = (person: string, storeName: string) => (person ? `${person} (${shortStoreName(storeName)} team)` : `${shortStoreName(storeName)} team`);

/** Every 4-character code in use: the admins' and the stores' team codes. */
export function usedCodes(state: Pick<AppState, 'admins' | 'stores'>): string[] {
  return [...Object.values(state.admins ?? {}).map((a) => a.code), ...Object.values(state.stores).flatMap((s: Store) => (s.access ? [s.access.code] : []))];
}
