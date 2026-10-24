import { useState } from 'react';
import { SteamCard } from '../components/SteamCard.tsx';
import { logout, useApp, usePendingWork, useSync } from '../lib/db.ts';
import { assess } from '../lib/assess.ts';
import { computeQueue } from '../lib/bracket.ts';
import { matchDayOpen } from '../lib/gate.ts';
import { storeDate } from '../lib/recce.ts';
import { isLegacy, revLabel, submissionState } from '../lib/submission.ts';
import type { Store, TournamentEvent } from '../lib/types.ts';
import { cx, fmtDate, fmtDateTime, fmtTime, todayLocal } from '../lib/util.ts';
import { PageHead, Shell, useNow } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { daysUntil, greeting, whenLabel } from '../lib/stages.ts';
import { winnersState } from '../lib/winnerInput.ts';
import { useStoreName } from '../components/useStoreName.ts';

/** Whether this device last left a store's submitted recce open. A convenience only — storage may be blocked. */
const reccePref = (storeId: string) => {
  try {
    return globalThis.localStorage?.getItem(`fd-recce-open:${storeId}`) === '1';
  } catch {
    return false;
  }
};
const saveReccePref = (storeId: string, open: boolean) => {
  try {
    if (open) globalThis.localStorage?.setItem(`fd-recce-open:${storeId}`, '1');
    else globalThis.localStorage?.removeItem(`fd-recce-open:${storeId}`);
  } catch {
    /* private mode / blocked storage — it just won't be remembered */
  }
};

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
        title={first ? `${greeting(new Date(now).getHours())}, ${first}.` : 'Your stores.'}
        deck={mine.length ? `${mine.length === 1 ? 'One store is' : `${mine.length} stores are`} assigned to you. Here’s everything left to do.` : undefined}
      />

      {!mine.length && (
        <EmptyCard mark="stores" title="No stores assigned yet." hint="When HQ assigns you a store it appears here by itself — no need to refresh." />
      )}

      <div className="tasks fd-stagger">
        {mine.map((s, i) => (
          <StoreTasks key={s.id} store={s} event={events[s.eventId]} now={now} index={i} />
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

function StoreTasks({ store, event, now, index }: { store: Store; event: TournamentEvent; now: number; index: number }) {
  const { short, prefix } = useStoreName(store);
  const a = assess(event, store);
  const r = store.recce;
  const st = submissionState(store, usePendingWork(store.id));
  const sent = st.kind === 'submitted' || st.kind === 'reviewed'; // acknowledged by the server, nothing changed since
  // Match day is closed until HQ has checked the recce (or the event date comes); until then the recce is the whole card.
  const gate = matchDayOpen(store, event, todayLocal(new Date(now)));
  const open = gate.open;
  // The recce folds away once HQ has it and match day leads; edited-since, waiting or failed submissions still need the admin's eyes.
  const [recceShown, setRecceShown] = useState(() => reccePref(store.id));
  const folds = sent && open;
  const recceOpen = !folds || recceShown;
  const sentLine = sent ? `${isLegacy(st.acknowledged) ? 'Submitted' : `Submitted ${revLabel(st.acknowledged!)}`}${st.kind === 'reviewed' ? ' · Reviewed by HQ ✓' : ' · HQ hasn’t opened it yet'}` : '';
  const day = store.day;
  const q = day.matches.length ? computeQueue(day) : null;
  const names = Object.fromEntries(day.players.map((p) => [p.id, p.name]));
  const played = day.matches.filter((m) => m.status === 'done' && !m.bye).length;
  const total = day.matches.filter((m) => !m.bye).length;
  const here = Object.keys(day.checkIn).length;
  // After the final: the winner's and runner-up's details are the next job, until both names + phones are saved.
  const ws = winnersState(day);
  const collect = ws.kind === 'collect' || (ws.kind === 'saved' && ws.missing) || (ws.kind === 'stale' && !!q?.champion);
  const selfIn = Object.keys(day.checkIn).filter((pid) => day.checkInSource?.[pid] === 'self').length;

  const date = storeDate(store, event);
  const days = daysUntil(date, todayLocal(new Date(now)));
  const when = whenLabel(days);

  const recceNote = sent
    ? `${st.kind === 'reviewed' ? 'Reviewed by HQ' : 'Sent to HQ'}${isLegacy(st.acknowledged) ? '' : ` · ${revLabel(st.acknowledged!)}`}`
    : st.kind === 'waiting'
      ? 'Sending — goes when there’s signal'
      : st.kind === 'failed'
        ? 'Not sent — open it to retry'
        : st.acknowledged
          ? `Edited since ${revLabel(st.acknowledged)}`
          : `${a.sections.filter((x) => x.done).length} of ${a.sections.length} sections done`;
  const dayNote = !open
    ? `Opens when HQ checks your recce, or on ${fmtDate(date, { day: 'numeric', month: 'short' })}`
    : q?.champion && !collect
      ? 'Finished'
      : collect
        ? 'Collect the winners’ details'
        : day.players.length
          ? `${here} of ${day.players.length} players here`
          : 'Open — HQ sends the bracket';

  const base = `#/store/${store.id}`;
  const next =
    open && collect
      ? { label: 'Collect winner details', href: `${base}/day` }
      : st.kind === 'failed'
        ? { label: 'Fix the recce submission', href: `${base}/recce` }
        : !st.acknowledged && st.kind !== 'waiting'
          ? { label: r.startedAt ? 'Continue the recce' : 'Start the recce', href: `${base}/recce` }
          : st.kind === 'draft' && days > 0
            ? { label: 'Submit the recce update', href: `${base}/recce` }
            : !open
              ? { label: 'View the recce', href: `${base}/recce` } // closed: never point at match day
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
    <article className={cx('task-card', sent && 'sent')} style={{ ['--i' as string]: index }}>
      <header>
        <div className="countdown">
          <span className={cx('count-pill', days >= 0 && days <= 1 && 'near', days < 0 && 'past')}>{when}</span>
          <span className="label">
            {fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })} · {event.name}
          </span>
        </div>
        {prefix && <span className="label store-kicker">{prefix}</span>}
        <h2>{short}</h2>
        <div className="task-where">{[store.city, store.address].filter(Boolean).join(' — ')}</div>
        <SteamCard store={store} />
        <ol className="journey" aria-label="Your two steps">
          <li className={cx('jstep', sent ? 'done' : 'current')}>
            <span className={cx('jmark', sent && 'fd-pop')}>{sent ? <Tick /> : '01'}</span>
            <span>
              <b>Recce</b>
              <small>{recceNote}</small>
            </span>
          </li>
          <li className="jline" aria-hidden />
          <li className={cx('jstep', !open ? 'locked' : q?.champion && !collect ? 'done' : 'current')}>
            <span className={cx('jmark', open && q?.champion && !collect && 'fd-pop')}>{open && q?.champion && !collect ? <Tick /> : '02'}</span>
            <span>
              <b>Match day</b>
              <small>{dayNote}</small>
            </span>
          </li>
        </ol>
        <a className="btn accent" href={next.href}>
          {next.label} →
        </a>
      </header>

      <section className={cx('recce-part', folds && 'sent', !open && 'main')}>
        {folds ? (
          <button
            type="button"
            className="fold-head"
            aria-expanded={recceOpen}
            aria-controls={`recce-${store.id}`}
            onClick={() => {
              setRecceShown(!recceOpen);
              saveReccePref(store.id, !recceOpen);
            }}
          >
            <h3>
              <span>01</span> Store recce
              <span className="h3-tick fd-pop">
                <Tick />
              </span>
            </h3>
            <small>{sentLine}</small>
            <em>{recceOpen ? 'Hide' : 'Show'}</em>
          </button>
        ) : (
          <h3>
            <span>01</span> Before the event — store recce
            {sent && (
              <span className="h3-tick fd-pop">
                <Tick />
              </span>
            )}
          </h3>
        )}
        {recceOpen && (
          <div id={`recce-${store.id}`}>
            <ol className="steps">
              {a.sections.map((s) =>
                step(s.done, s.title, s.done ? (s.issues[0] ?? 'Done') : s.todo.slice(0, 2).join(' · ') + (s.todo.length > 2 ? ` · +${s.todo.length - 2} more` : ''), s.done && s.issues.length > 0),
              )}
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
          </div>
        )}
      </section>

      {!open ? (
        <section className="day-part gated">
          <h3>
            <span>02</span> On the day — match day
          </h3>
          <p className="gate-line">
            {st.acknowledged ? 'Sent — waiting for HQ to check it. Match day opens once they have' : 'Match day opens once HQ checks your recce'} (or on{' '}
            {fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}).
          </p>
        </section>
      ) : (
        <section className={cx('day-part', sent && 'main')}>
          <h3>
            <span>02</span> On the day — match day
          </h3>
          {gate.reason === 'event-day' && <p className="gate-note">Open because it’s the event date — HQ hasn’t checked the recce yet.</p>}
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
            {(q?.champion || day.winners) &&
              step(
                ws.kind === 'saved' && !ws.missing,
                ws.kind === 'saved' && !ws.missing ? 'Winners: details saved ✓' : 'Winner details',
                ws.kind === 'stale'
                  ? 'Saved details no longer match the bracket — open match day'
                  : ws.kind === 'saved'
                    ? `${ws.missing ? 'Still needs a real name or phone' : 'Winner and runner-up'} · saved ${fmtTime(day.winners!.updatedAt)} by ${day.winners!.by}`
                    : 'Collect the winner’s and runner-up’s name, phone, email and Instagram',
                ws.kind === 'stale' || (ws.kind === 'saved' && ws.missing),
              )}
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
      )}
    </article>
  );
}

/** A check mark that takes the colour of its container. */
const Tick = () => (
  <svg viewBox="0 0 16 16" aria-hidden>
    <path d="M3 8.5l3.2 3.2L13 5" />
  </svg>
);
