import { useApp } from '../lib/db.ts';
import { campaignStoreNames, storePrefix, storeShortName } from '../lib/names.ts';

/**
 * A store's on-screen name — "Incredible Technologies" for "ASUS ROG Exclusive Store — Incredible
 * Technologies" — and the part that was dropped, judged against the rest of its campaign (lib/names.ts).
 * Call it before any early return; it takes the store as it may still be missing.
 */
export function useStoreName(store: { name: string; eventId: string } | undefined) {
  const joined = useApp((s) => (store ? campaignStoreNames(Object.values(s.stores), store.eventId).join('\n') : ''));
  const names = joined ? joined.split('\n') : [];
  return { short: store ? storeShortName(store.name, names) : '', prefix: store ? storePrefix(store.name, names) : '' };
}
