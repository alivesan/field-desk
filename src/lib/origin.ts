import { useSyncExternalStore } from 'react';

/*
 * The address other devices should open. Normally the page's own origin; but when HQ runs the app
 * on the PC at localhost, admin links and check-in QR codes made there must carry the PC's Wi-Fi
 * address instead ("https://192.168.1.35:5173/K7Q2"), or the phone can't open them.
 */

export interface LanInfo {
  origins: string[]; // this machine's Wi-Fi addresses, best first
  reachable: boolean; // false when the server only listens on localhost (plain `npm run dev`)
  https: boolean;
}

let lan: LanInfo | null = null;
const listeners = new Set<() => void>();

export const isLocalhost = (host = location.hostname) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/** Origin for links and QR codes meant for other devices. */
export const shareOrigin = () => (isLocalhost() && lan?.reachable && lan.origins[0]) || location.origin;

/** Asks the server for its Wi-Fi addresses — only needed (and only asked) on localhost. */
export async function loadLan() {
  if (!isLocalhost() || lan) return;
  try {
    const r = await fetch('/api/lan', { credentials: 'same-origin' });
    if (!r.ok) return;
    const j = (await r.json()) as Partial<LanInfo>;
    lan = { origins: Array.isArray(j.origins) ? j.origins.filter((o) => typeof o === 'string') : [], reachable: j.reachable !== false, https: !!j.https };
    listeners.forEach((l) => l());
  } catch {
    /* offline or older server: links keep the page's own origin */
  }
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

/** Re-renders once the Wi-Fi address is known; null when not on localhost or not known yet. */
export function useLan(): LanInfo | null {
  return useSyncExternalStore(subscribe, () => (isLocalhost() ? lan : null));
}
