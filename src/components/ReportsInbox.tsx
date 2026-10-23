import { useApp } from '../lib/db.ts';
import { assess, verdictLabel } from '../lib/assess.ts';
import { storeDate } from '../lib/recce.ts';
import { editedSince, isLegacy, latestSubmission, revLabel, submissionPolicy } from '../lib/submission.ts';
import { ago, cx, todayLocal } from '../lib/util.ts';
import { Chip, useNow } from './ui.tsx';

/*
 * HQ's inbox: each store's latest submitted revision, newest first. "New" = that revision
 * hasn't been opened on this device yet — so a re-submission is new again.
 */

const SEEN_KEY = 'fd-seen-reports';

function seen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Remember that HQ opened this revision (storeId → submission id). */
export function markReportSeen(storeId: string, submissionId: string) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen(), [storeId]: submissionId }));
  } catch {
    /* private mode — "New" just stays on */
  }
}

export function ReportsInbox() {
  const stores = useApp((s) => s.stores);
  const events = useApp((s) => s.events);
  const now = useNow(30000);
  const opened = seen();

  const all = Object.values(stores).filter((s) => events[s.eventId]);
  const submitted = all
    .map((s) => ({ s, sub: latestSubmission(s) }))
    .filter((x): x is { s: (typeof all)[number]; sub: NonNullable<typeof x.sub> } => !!x.sub)
    .sort((a, b) => b.sub.submittedAt.localeCompare(a.sub.submittedAt));
  const today = todayLocal(new Date(now));
  const waiting = all.filter((s) => !latestSubmission(s) && storeDate(s, events[s.eventId]) >= today).length;
  const isNew = (storeId: string, subId: string) => opened[storeId] !== subId;
  const fresh = submitted.filter((x) => isNew(x.s.id, x.sub.id)).length;

  return (
    <section className="inbox">
      <div className="index-head">
        <h2>Recce reports</h2>
        <span className="label">
          {fresh ? <b className="new-count">{fresh} new</b> : null}
          {fresh ? ' · ' : ''}
          {submitted.length} in · {waiting} still to come
        </span>
      </div>
      {submitted.length ? (
        <ol className="inbox-list">
          {submitted.map(({ s, sub }) => {
            const ev = events[s.eventId];
            // Judged as submitted: that revision's recce, against the requirements it was sent under.
            const a = assess(ev, s, { recce: sub.recce, policy: submissionPolicy(sub) });
            const fresh = isNew(s.id, sub.id);
            const status = sub.reviewedAt ? 'Reviewed' : 'Not reviewed';
            return (
              <li key={sub.id} className={cx(fresh && 'new')}>
                <a className="inbox-main" href={`#/store/${s.id}/report`}>
                  <span className="inbox-dot" aria-label={fresh ? 'New' : undefined} />
                  <span className="inbox-text">
                    <strong>{s.name}</strong>
                    <small>
                      {ev.name} · {sub.byName || s.admin || 'No admin'} · {isLegacy(sub) ? '' : `${revLabel(sub)} · `}
                      {ago(sub.submittedAt, now)} · {status}
                      {editedSince(s, sub) ? ' · edited since' : ''}
                    </small>
                  </span>
                  <Chip tone={a.verdict === 'ready' ? 'ok' : 'warn'}>{verdictLabel(a.verdict, true)}</Chip>
                </a>
                <a className="btn ghost inbox-pdf" href={`#/store/${s.id}/report/pdf`}>
                  PDF
                </a>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty">No reports yet. Each one lands here once an admin’s “Submit to HQ” reaches the server.</p>
      )}
    </section>
  );
}
