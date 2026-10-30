import { useEffect, useSyncExternalStore } from 'react';
import { moduleScript } from '../lib/update.ts';

/*
 * A phone can keep running the bundle it loaded days ago. Every 2 minutes, and when the tab
 * comes back to the front, ask the server for the page and compare its module script with the one
 * this tab loaded. State lives here, not in the component: every page mounts its own Shell, and
 * "a new version is ready" must survive moving between them. Never reloads by itself — someone may be typing.
 */
const listeners = new Set<() => void>();
let stale = false;
let watching = false;

async function check() {
  if (stale) return;
  const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src');
  if (!mine) return;
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return;
    const theirs = moduleScript(await res.text());
    if (theirs && theirs !== mine) {
      stale = true;
      listeners.forEach((l) => l());
    }
  } catch {
    // offline — the next check will do
  }
}

function watch() {
  if (watching || import.meta.env.DEV) return;
  watching = true;
  setInterval(check, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** A slim bar under the header once a newer version has been deployed. */
export function UpdateBar() {
  useEffect(watch, []);
  const ready = useSyncExternalStore(subscribe, () => stale);
  if (!ready) return null;
  return (
    <div className="update-bar" role="status">
      <span>A new version of Field Desk is ready.</span>
      <button type="button" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
