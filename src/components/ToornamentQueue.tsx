import { useCallback, useEffect, useRef, useState } from 'react';
import { updateStore, useApp } from '../lib/db.ts';
import { countsLine, queueCounts, unsendableMatches, type QueueJob, type Unsendable } from '../lib/toornament-queue.ts';
import type { Store } from '../lib/types.ts';
import { cx, todayLocal } from '../lib/util.ts';
import '../styles/toornament-queue.css';

/*
 * HQ and the Toornament result queue (docs/toornament-jobs.md, "HQ"): the jobs from GET /api/toornament/jobs kept fresh,
 * settling one (POST …/resolve), the per-store switch with its one-line count and the matches the queue can't cover (the
 * store's Toornament panel), and the one-line link on HQ's home. The to-do page itself is pages/ToornamentQueuePage.tsx.
 */

export const localDay = (iso: string) => todayLocal(new Date(iso));

export interface Queue {
  /** null until the first answer. */
  jobs: QueueJob[] | null;
  error: string;
  reload: () => Promise<void>;
}

/**
 * The jobs (one store's, or all), fetched now and then every `everyMs` while the page is visible (and again when it becomes
 * visible). `everyMs` 0 = once.
 */
export function useQueue(storeId?: string, everyMs = 0): Queue {
  const [state, setState] = useState<{ jobs: QueueJob[] | null; error: string }>({ jobs: null, error: '' });
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const r = await fetch(storeId ? `/api/toornament/jobs?${new URLSearchParams({ storeId })}` : '/api/toornament/jobs');
      const body = await r.json().catch(() => null);
      if (!alive.current) return;
      if (!r.ok) {
        const error = r.status === 401 ? 'You’re signed out — sign in again.' : r.status === 403 ? 'Only HQ can see this.' : (body?.error ?? `Couldn’t load the Toornament queue (${r.status}).`);
        return setState((s) => ({ jobs: s.jobs, error }));
      }
      setState({ jobs: (body?.jobs ?? []) as QueueJob[], error: '' });
    } catch {
      if (alive.current) setState((s) => ({ jobs: s.jobs, error: 'Couldn’t reach the Field Desk server — will try again.' }));
    }
  }, [storeId]);
  useEffect(() => {
    alive.current = true;
    void load();
    const visible = () => document.visibilityState === 'visible';
    const timer = everyMs > 0 ? setInterval(() => visible() && void load(), everyMs) : undefined;
    const onVisible = () => visible() && void load();
    if (everyMs > 0) document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, everyMs]);
  return { ...state, reload: load };
}

/** HQ settles a job that needs a person. Resolves to an error message, or '' when it worked. */
export async function resolveJob(id: string, action: 'manual' | 'retry'): Promise<string> {
  try {
    const r = await fetch(`/api/toornament/jobs/${encodeURIComponent(id)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    if (r.ok) return '';
    const body = await r.json().catch(() => null);
    return r.status === 401 ? 'You’re signed out — sign in again.' : (body?.error ?? `That didn’t work (${r.status}).`);
  } catch {
    return 'Couldn’t reach the Field Desk server — check the connection and try again.';
  }
}

/** The matches a store's setup can't send, grouped by reason: a few get a line each, many one line. */
function Unsendables({ list }: { list: Unsendable[] }) {
  const groups = new Map<string, Unsendable[]>();
  for (const u of list) groups.set(u.reason, [...(groups.get(u.reason) ?? []), u]);
  return (
    <ul className="tq-block">
      {[...groups.values()].flatMap((g) =>
        g.length <= 3 ? g.map((u) => <li key={u.matchId}><b>{u.title}</b> — {u.text} Enter this one by hand.</li>) : [<li key={g[0].reason}><b>{g.length} matches</b> ({g.slice(0, 3).map((u) => u.title.split(' · ')[0]).join(', ')} …) — {g[0].text} Enter these by hand.</li>],
      )}
    </ul>
  );
}

/** HQ, one store: the switch that sends this store's results to Toornament, how the queue stands, and what it can't cover. */
export function SendResults({ store }: { store: Store }) {
  const on = store.toornament?.sync?.on === true;
  const { jobs } = useQueue(store.id, 15000);
  const set = (next: boolean) => updateStore(store.id, (s) => void (s.toornament && (s.toornament.sync = { on: next })));
  const counts = jobs && jobs.length ? queueCounts(jobs, todayLocal(), localDay) : null;
  const blocked = on ? unsendableMatches(store) : [];
  if (!store.toornament?.url) return null;
  return (
    <div className={cx('tn-auto', 'tq-send', on ? (counts?.needsYou ? 'warn' : 'ok') : '')}>
      <label className="tn-auto-switch tq-switch">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Send results to Toornament
      </label>
      <p className="hint">Off by default. When on, finished and undone matches go to Toornament through Astra’s worker — win or loss only, no scores.</p>
      {(on || counts) && (
        <p className="tq-count">
          {counts ? countsLine(counts) : jobs ? 'Nothing sent yet.' : 'Checking the queue…'} · <a href="#/toornament">Toornament to-do</a>
        </p>
      )}
      {blocked.length > 0 && (
        <div className="tq-blocked">
          <p>These matches can’t be sent:</p>
          <Unsendables list={blocked} />
        </div>
      )}
    </div>
  );
}

/** HQ's home: one line about the queue, when any store sends its results. */
export function QueueHomeLink() {
  const anyOn = useApp((s) => Object.values(s.stores).some((x) => x.toornament?.sync?.on === true));
  const { jobs } = useQueue(undefined, anyOn ? 30000 : 0);
  if (!anyOn) return null;
  const counts = jobs ? queueCounts(jobs, todayLocal(), localDay) : null;
  return (
    <section className={cx('tq-home', !!counts?.needsYou && 'warn')} aria-label="Toornament results">
      <div>
        <div className="label">Toornament results</div>
        <p>{counts ? countsLine(counts) : 'Checking the queue…'}</p>
      </div>
      <a className={cx('btn', counts?.needsYou ? 'accent' : 'ghost')} href="#/toornament">
        Toornament to-do
      </a>
    </section>
  );
}
