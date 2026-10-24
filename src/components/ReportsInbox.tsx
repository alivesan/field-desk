import { usePendingWork, useApp } from '../lib/db.ts';
import { assess, verdictLabel } from '../lib/assess.ts';
import { storeDate } from '../lib/recce.ts';
import { submissionVersion } from '../lib/commands.ts';
import { editedSince, isLegacy, latestSubmission, revLabel, submissionPolicy, submissionsOf, type AnySubmission } from '../lib/submission.ts';
import type { Store } from '../lib/types.ts';
import { ago, cx, todayLocal } from '../lib/util.ts';
import { askConfirm, Chip, notify, toast, useNow } from './ui.tsx';
import { EmptyCard } from './flair.tsx';
import { useHqCommand } from './hqCommand.ts';
import '../styles/hq-delete.css';

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
  const send = useHqCommand();
  const removing = usePendingWork().filter((w) => w.cmd?.type === 'recce.delete' || w.cmd?.type === 'recce.reset');
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

  /** Delete the report listed here: the latest revision (the one before it, if any, becomes the listed one), or — for a report that predates revisions — reset the recce. */
  const remove = async (s: Store, sub: AnySubmission) => {
    const subs = submissionsOf(s);
    const prev = subs.length > 1 ? subs[subs.length - 2] : undefined;
    const legacy = isLegacy(sub);
    const text = legacy
      ? `Delete the report for ${s.name}? It predates revisions, so this resets the store’s recce: the admin will have to do it again. Photos already uploaded stay on the server but aren’t shown.`
      : `Delete ${revLabel(sub)} of ${s.name}? It leaves the Recce reports for good${prev ? `; ${revLabel(prev)} becomes the one listed` : ''}. The admin’s working recce is not touched, and photos already uploaded stay on the server but aren’t shown.`;
    if (!(await askConfirm(text, { ok: legacy ? 'Reset recce' : `Delete ${revLabel(sub)}`, danger: true }))) return;
    const problem = send(s.id, (cur) => (legacy ? { type: 'recce.reset', base: submissionVersion(cur) } : { type: 'recce.delete', base: submissionVersion(cur), submissionId: sub.id }));
    if (problem) return void notify(problem);
    // Deleting a revision HQ had opened must not make the one before it "new" again.
    if (prev && opened[s.id] === sub.id) markReportSeen(s.id, prev.id);
    toast(legacy ? 'Recce reset' : `${revLabel(sub)} deleted`);
  };

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
        <ol className="inbox-list fd-stagger">
          {submitted.map(({ s, sub }, i) => {
            const ev = events[s.eventId];
            // Judged as submitted: that revision's recce, against the requirements it was sent under.
            const a = assess(ev, s, { recce: sub.recce, policy: submissionPolicy(sub) });
            const fresh = isNew(s.id, sub.id);
            const status = sub.reviewedAt ? 'Reviewed' : 'Not reviewed';
            return (
              <li key={sub.id} className={cx(fresh && 'new')} style={{ ['--i' as string]: i }}>
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
                <button className="link inbox-delete" title="Delete this report (test data)" disabled={removing.some((w) => w.storeId === s.id)} onClick={() => remove(s, sub)}>
                  Delete
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyCard compact mark="inbox" title="No reports yet." hint="Each one lands here once an admin’s “Submit to HQ” reaches the server." />
      )}
    </section>
  );
}
