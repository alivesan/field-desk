import { logout, useApp, usePendingWork, useSync } from '../lib/db.ts';
import { assess } from '../lib/assess.ts';
import { computeQueue } from '../lib/bracket.ts';
import { storeDate } from '../lib/recce.ts';
import { isLegacy, revLabel, submissionState } from '../lib/submission.ts';
import type { Store, TournamentEvent } from '../lib/types.ts';
import { cx, fmtDate, fmtDateTime } from '../lib/util.ts';
import { PageHead, Shell, useNow } from '../components/ui.tsx';

/** A field admin's whole world: their assigned stores, as a to-do list. */
export function AdminHome() {
  const { name } = useSync();
  const stores = useApp((s) => s.stores);
  const events = useApp((s) => s.events);
  const now = useNow(60000);
  // The server only sends this admin's own stores.
  const mine = Object.values(stores)
    .filter((s) => events[s.eventId])
    .sort((a, b) => storeDate(a, events[a.eventId]).localeCompare(storeDate(b, events[b.eventId])) || a.name.localeCompare(b.name));
  const first = name?.split(' ')[0];

  return (
    <Shell crumbs={[{ label: 'My stores' }]}>
      <PageHead
        kicker="Your work"
        title={first ? `Hi ${first}.` : 'Your stores.'}
        deck={mine.length ? `${mine.length === 1 ? 'One store is' : `${mine.length} stores are`} assigned to you. Here’s everything left to do.` : undefined}
      />

      {!mine.length && (
        <div className="empty-state">
          <p>No stores assigned yet.</p>
          <span className="hint">When HQ assigns you a store it appears here by itself — no need to refresh.</span>
        </div>
      )}

      <div className="tasks">
        {mine.map((s) => (
          <StoreTasks key={s.id} store={s} event={events[s.eventId]} now={now} />
        ))}
      </div>

      <section className="data-tools">
        <button className="link" onClick={logout}>
          Sign out of this device
        </button>
      </section>
    </Shell>
  );
}

function StoreTasks({ store, event, now }: { store: Store; event: TournamentEvent; now: number }) {
  const a = assess(event, store);
  const r = store.recce;
  const st = submissionState(store, usePendingWork(store.id));
  const sent = st.kind === 'submitted' || st.kind === 'reviewed'; // acknowledged by the server, nothing changed since
  const day = store.day;
  const q = day.matches.length ? computeQueue(day) : null;
  const names = Object.fromEntries(day.players.map((p) => [p.id, p.name]));
  const played = day.matches.filter((m) => m.status === 'done' && !m.bye).length;
  const total = day.matches.filter((m) => !m.bye).length;
  const here = Object.keys(day.checkIn).length;
  const selfIn = Object.keys(day.checkIn).filter((pid) => day.checkInSource?.[pid] === 'self').length;

  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const date = storeDate(store, event);
  const days = Math.round((new Date(date + 'T00:00:00').getTime() - today) / 864e5);
  const when = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `In ${days} days` : `${-days} day${days === -1 ? '' : 's'} ago`;

  const base = `#/store/${store.id}`;
  const next =
    st.kind === 'failed'
      ? { label: 'Fix the recce submission', href: `${base}/recce` }
      : !st.acknowledged && st.kind !== 'waiting'
        ? { label: r.startedAt ? 'Continue the recce' : 'Start the recce', href: `${base}/recce` }
        : st.kind === 'draft' && days > 0
          ? { label: 'Submit the recce update', href: `${base}/recce` }
      : !q?.champion && (days <= 0 || day.players.length)
        ? { label: 'Open match day', href: `${base}/day` }
        : { label: 'View the report', href: `${base}/report` };

  const step = (done: boolean, title: string, detail: string, warn?: boolean) => (
    <li key={title} className={cx(done && 'done', warn && 'warn')}>
      <span className="tick" aria-hidden />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </li>
  );

  return (
    <article className="task-card">
      <header>
        <div className="label">
          {fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })} · <span className={cx(days <= 1 && days >= 0 && 'soon')}>{when}</span> · {event.name}
        </div>
        <h2>{store.name}</h2>
        <div className="task-where">{[store.city, store.address].filter(Boolean).join(' — ')}</div>
        <a className="btn accent" href={next.href}>
          {next.label} →
        </a>
      </header>

      <section>
        <h3>
          <span>01</span> Before the event — store recce
        </h3>
        <ol className="steps">
          {a.sections.map((s) => step(s.done, s.title, s.done ? (s.issues[0] ?? 'Done') : s.todo.slice(0, 2).join(' · ') + (s.todo.length > 2 ? ` · +${s.todo.length - 2} more` : ''), s.done && s.issues.length > 0))}
          {step(
            sent,
            st.kind === 'reviewed' ? 'Reviewed by HQ' : 'Submit to HQ',
            st.kind === 'waiting'
              ? 'Waiting to send — goes to HQ when there’s signal'
              : st.kind === 'failed'
                ? `Not sent — ${st.work?.error ?? 'open the recce to retry'}`
                : sent
                  ? `${isLegacy(st.acknowledged) ? 'Submitted' : `Submitted ${revLabel(st.acknowledged!)}`} · ${fmtDateTime(st.acknowledged!.submittedAt)}`
                  : st.acknowledged
                    ? `Edited since ${revLabel(st.acknowledged)} — submit the update`
                    : 'When everything above is done',
            st.kind === 'failed' || (st.kind === 'draft' && !!st.acknowledged),
          )}
        </ol>
        <div className="row">
          <a className="btn ghost" href={`${base}/recce`}>
            Recce
          </a>
          <a className="btn ghost" href={`${base}/report`}>
            Report
          </a>
        </div>
      </section>

      <section>
        <h3>
          <span>02</span> On the day — match day
        </h3>
        <ol className="steps">
          {step(day.players.length > 0, 'Bracket loaded', day.players.length ? `${day.players.length} players · sent by HQ` : 'HQ sends it — it appears here automatically')}
          {step(
            day.players.length > 0 && here === day.players.length,
            'Check players in',
            day.players.length
              ? `${here} of ${day.players.length} here${selfIn ? ` · ${selfIn} by QR` : ''}${day.selfCheckIn?.open ? ' · QR check-in open' : days === 0 ? ' · tip: open QR check-in so players check themselves in' : ''}`
              : 'On the day, open QR check-in on match day — players scan and check themselves in',
          )}
          {step(!!q?.champion, 'Run the matches', total ? `${played} of ${total} played${q && q.live.length ? ` · ${q.live.length} live now` : ''}` : 'Call each match from the queue')}
          {step(!!q?.champion, 'Champion', q?.champion ? names[q.champion] : '—')}
        </ol>
        <div className="row">
          <a className="btn ghost" href={`${base}/day`}>
            Match day
          </a>
          <a className="btn ghost" href={`${base}/board`} target="_blank" rel="noreferrer">
            Venue board ↗
          </a>
        </div>
      </section>
    </article>
  );
}
