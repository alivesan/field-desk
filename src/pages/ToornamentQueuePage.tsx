import { useMemo, useState } from 'react';
import { useApp } from '../lib/db.ts';
import { campaignStoreNames, storeShortName } from '../lib/names.ts';
import { codeText, jobMatchTitle, jobWhat, needsHq, queueCounts, sortQueue, STATE_TEXT, STATE_TONE, type QueueJob } from '../lib/toornament-queue.ts';
import type { Store } from '../lib/types.ts';
import { ago, cx, todayLocal } from '../lib/util.ts';
import { askConfirm, Chip, notify, PageHead, Shell, Skeleton, toast, useNow } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { localDay, resolveJob, useQueue } from '../components/ToornamentQueue.tsx';
import '../styles/toornament-queue.css';

/*
 * HQ: the Toornament to-do (#/toornament). The result jobs Field Desk keeps for Astra's browser worker, by store: what each
 * one does, where it stands, and — for the ones that need a person — "Fixed on Toornament by hand" and "Try again". Needs-you
 * first; done and cancelled ones are hidden until asked for. Polls every 15 s while the page is visible. A field admin never
 * gets here (App.tsx), and the server refuses anyone but HQ.
 */

const POLL_MS = 15000;

export function ToornamentQueuePage() {
  const { jobs, error, reload } = useQueue(undefined, POLL_MS);
  const stores = useApp((s) => s.stores);
  const [showAll, setShowAll] = useState(false);
  const now = useNow(30000);

  const groups = useMemo(() => {
    const by = new Map<string, QueueJob[]>();
    for (const j of sortQueue((jobs ?? []).filter((x) => showAll || !quiet(x.state)))) by.set(j.storeId, [...(by.get(j.storeId) ?? []), j]);
    // Stores with something for HQ first, then the rest as sorted (the newest activity first).
    return [...by.entries()].sort((a, b) => Number(b[1].some((j) => needsHq(j.state))) - Number(a[1].some((j) => needsHq(j.state))));
  }, [jobs, showAll]);
  const hidden = (jobs ?? []).filter((j) => quiet(j.state)).length;
  const counts = jobs ? queueCounts(jobs, todayLocal(new Date(now)), localDay) : null;

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: 'Toornament to-do' }]}>
      <i className="hq-wide" hidden />
      <PageHead kicker="HQ" title="Toornament to-do." deck="Results Field Desk is sending to Toornament through the worker. Anything that needs you is at the top — look on Toornament, then say what you found." />

      {error && (
        <p className="tn-error" role="alert">
          {error}{' '}
          <button className="link" onClick={() => void reload()}>
            Try now
          </button>
        </p>
      )}

      {jobs === null ? (
        !error && (
          <div className="tq-loading" role="status" aria-busy="true">
            <span className="sr-only">Loading the Toornament queue…</span>
            <Skeleton w="60%" h={18} />
            <Skeleton h={64} />
            <Skeleton h={64} />
          </div>
        )
      ) : (
        <>
          <div className="tq-bar">
            <p className="tq-summary">
              {counts && (
                <>
                  <b>{counts.needsYou}</b> {counts.needsYou === 1 ? 'needs' : 'need'} you · <b>{counts.waiting}</b> waiting · <b>{counts.doneToday}</b> done today
                </>
              )}
            </p>
            {hidden > 0 && (
              <label className="tq-toggle">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show done and cancelled ({hidden})
              </label>
            )}
          </div>

          {groups.length === 0 ? (
            <EmptyCard mark="team" title={jobs.length ? 'Nothing waiting.' : 'Nothing queued yet.'} hint={jobs.length ? 'Every result has been sent. Tick “Show done and cancelled” to see them.' : 'When a store sends its results to Toornament (switch it on in the store’s Toornament panel), each finished match shows up here.'} />
          ) : (
            groups.map(([storeId, list]) => <StoreGroup key={storeId} store={stores[storeId]} storeId={storeId} jobs={list} onChanged={reload} />)
          )}
        </>
      )}
    </Shell>
  );
}

function StoreGroup({ store, storeId, jobs, onChanged }: { store: Store | undefined; storeId: string; jobs: QueueJob[]; onChanged: () => Promise<void> }) {
  const stores = useApp((s) => s.stores);
  const name = store ? storeShortName(store.name, campaignStoreNames(Object.values(stores), store.eventId)) : 'A store that is gone';
  const mine = jobs.filter((j) => needsHq(j.state)).length;
  return (
    <section className="tq-store" aria-label={name}>
      <header className="tq-store-head">
        <h2>{name}</h2>
        {mine > 0 && <Chip tone="warn">{mine} {mine === 1 ? 'needs' : 'need'} you</Chip>}
        {store && (
          <a className="tq-store-link" href={`#/store/${storeId}/players`}>
            Store →
          </a>
        )}
      </header>
      <ol className="tq-jobs">
        {jobs.map((j) => (
          <Job key={j.id} job={j} store={store} onChanged={onChanged} />
        ))}
      </ol>
    </section>
  );
}

function Job({ job, store, onChanged }: { job: QueueJob; store: Store | undefined; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const now = useNow(30000);
  const title = jobMatchTitle(job, store?.day.matches);
  const what = jobWhat(job);
  const attempts = job.attempt === 0 ? 'not tried yet' : `${job.attempt} ${job.attempt === 1 ? 'attempt' : 'attempts'}`;
  const code = codeText(job.code);
  // A line that ends the way the worker left it; "waiting" with no news says nothing.
  const note = job.state === 'pending' && job.code === 'created' ? '' : code;

  const settle = async (action: 'manual' | 'retry') => {
    const ok = await askConfirm(
      action === 'manual'
        ? `${title} — ${what}. Is this result on Toornament now, and right? Field Desk will stop trying to send it.`
        : `Send ${title} — ${what} again? The worker will look at Toornament first and only save if the result isn’t there.`,
      { ok: action === 'manual' ? 'Yes, it’s fixed' : 'Try again' },
    );
    if (!ok) return;
    setBusy(true);
    const problem = await resolveJob(job.id, action);
    setBusy(false);
    await onChanged(); // also when it failed: the job may have moved on already
    if (problem) void notify(problem);
    else toast(action === 'manual' ? 'Marked as fixed on Toornament' : 'Sent back to the worker');
  };

  return (
    <li className={cx('tq-job', needsHq(job.state) && 'hq', quiet(job.state) && 'quiet')}>
      <div className="tq-top">
        <b className="tq-match">{title}</b>
        <Chip tone={STATE_TONE[job.state]}>{STATE_TEXT[job.state]}</Chip>
      </div>
      <div className="tq-what">{what}</div>
      <div className="tq-meta">
        <span>{attempts}</span>
        {note && <span>{note}</span>}
        <span>{ago(job.updatedAt, now)}</span>
      </div>
      {needsHq(job.state) && (
        <div className="tq-actions">
          <button className="btn accent" disabled={busy} onClick={() => void settle('manual')}>
            Fixed on Toornament by hand
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void settle('retry')}>
            Try again
          </button>
        </div>
      )}
    </li>
  );
}

const quiet = (s: QueueJob['state']) => s === 'done' || s === 'cancelled';
