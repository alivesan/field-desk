import { useSyncExternalStore } from 'react';

const read = () => window.location.hash.replace(/^#\/?/, '');
const subscribe = (l: () => void) => {
  window.addEventListener('hashchange', l);
  return () => window.removeEventListener('hashchange', l);
};

/** Hash route split into segments: "#/store/abc/recce" -> ["store", "abc", "recce"]. */
export function useRoute() {
  const path = useSyncExternalStore(subscribe, read);
  return path.split('/').filter(Boolean);
}

export function go(path: string) {
  window.location.hash = path;
  window.scrollTo(0, 0);
}
