import { usePendingWork, useApp } from '../lib/db.ts';
import { assess, verdictLabel } from '../lib/assess.ts';
import { homeReports } from '../lib/home.ts';
import { submissionVersion } from '../lib/commands.ts';
import { editedSince, isLegacy, latestSubmission, revLabel, submissionPolicy, submissionsOf, type AnySubmission } from '../lib/submission.ts';
import type { Store } from '../lib/types.ts';
import { ago, cx, todayLocal } from '../lib/util.ts';
import { askConfirm, Chip, notify, toast, useNow } from './ui.tsx';
import { EmptyCard } from './flair.tsx';
import { useHqCommand } from './hqCommand.ts';
import { campaignStoreNames, storeShortName } from '../lib/names.ts';
import '../styles/hq-delete.css';

/*
 * HQ's home inbox: the reports worth a look now — each store's latest revision, not reviewed yet, for a store playing this
 * weekend or next (lib/home.ts homeReports), newest first. "New" = that revision hasn't been opened on this device yet, so a
 * re-submission is new again. Reviewing one takes it out of the box; a weekend that is over drops off on the Monday. Every
 * report stays on its campaign's page (CampaignReports) and on the store's report page.
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
  const pending = usePendingWork();
  const removing = pending.filter((w) => w.cmd?.type === 'recce.delete' || w.cmd?.type === 'recce.reset');
  // A review on its way leaves the box at once; one that failed stays, so it can be tried again.
  const reviewing = pending.filter((w) => w.cmd?.type === 'recce.review' && w.state !== 'failed' && w.state !== 'conflict');
  const stores = useApp((s) => s.stores);
  const events = useApp((s) => s.events);
  const now = useNow(30000);
  const opened = seen();

  const all = Object.values(stores).filter((s) => events[s.eventId]);
  const today = todayLocal(new Date(now));
  const rows = homeReports({ events, stores }, today).filter((r) => !reviewing.some((w) => w.storeId === r.store.id));
  const isNew = (storeId: string, subId: string) => opened[storeId] !== subId;
  const fresh = rows.filter((r) => isNew(r.store.id, r.sub.id)).length;

  const approve = (s: Store, sub: AnySubmission) => {
    if (isLegacy(sub)) return; // a report from before revisions can't be reviewed
    const problem = send(s.id, (cur) => ({ type: 'recce.review', base: submissionVersion(cur), submissionId: sub.id }));
    if (problem) return void notify(problem);
    toast('Recce approved ✓ — moved to the campaign');
  };

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
          {rows.length} to review · this weekend &amp; next
        </span>
      </div>
      {rows.length ? (
        <ol className="inbox-list fd-stagger">
          {rows.map(({ store: s, event: ev, sub }, i) => {
            // Judged as submitted: that revision's recce, against the requirements it was sent under.
            const a = assess(ev, s, { recce: sub.recce, policy: submissionPolicy(sub) });
            const fresh = isNew(s.id, sub.id);
            return (
              <li key={sub.id} className={cx(fresh && 'new')} style={{ ['--i' as string]: i }}>
                <a className="inbox-main" href={`#/store/${s.id}/report`}>
                  <span className="inbox-dot" aria-label={fresh ? 'New' : undefined} />
                  <span className="inbox-text">
                    <strong>{storeShortName(s.name, campaignStoreNames(all, s.eventId))}</strong>
                    <small>
                      {ev.name} · {sub.byName || s.admin || 'No admin'} · {isLegacy(sub) ? '' : `${revLabel(sub)} · `}
                      {ago(sub.submittedAt, now)}
                      {editedSince(s, sub) ? ' · edited since' : ''}
                    </small>
                  </span>
                  <Chip tone={a.verdict === 'ready' ? 'ok' : 'warn'}>{verdictLabel(a.verdict, true)}</Chip>
                </a>
                {!isLegacy(sub) && (
                  <button className="btn inbox-approve" title="Approve this recce — it moves to the campaign" onClick={() => approve(s, sub)}>
                    Approve recce
                  </button>
                )}
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
        <EmptyCard compact mark="inbox" title="Nothing to review." hint="Reports from this weekend’s and next weekend’s stores wait here until you review them. Every report is also on its campaign’s page." />
      )}
    </section>
  );
}

/** A campaign's recce reports, all of them: each store's latest revision, newest first. Open while any is still to review. */
export function CampaignReports({ stores }: { stores: Store[] }) {
  const now = useNow(30000);
  const names = stores.map((s) => s.name);
  const reports = stores
    .map((s) => ({ s, sub: latestSubmission(s) }))
    .filter((x): x is { s: Store; sub: AnySubmission } => !!x.sub)
    .sort((a, b) => b.sub.submittedAt.localeCompare(a.sub.submittedAt));
  if (!reports.length) return null;
  const todo = reports.filter((x) => !x.sub.reviewedAt).length;
  return (
    <details className="camp-reports" open={todo > 0}>
      <summary>
        All recce reports <b>{reports.length}</b>
        <span className="label">{todo ? `${todo} to review` : 'all reviewed'}</span>
      </summary>
      <ol className="inbox-list">
        {reports.map(({ s, sub }) => (
          <li key={s.id}>
            <a className="inbox-main" href={`#/store/${s.id}/report`}>
              <span className="inbox-text">
                <strong>{storeShortName(s.name, names)}</strong>
                <small>
                  {sub.byName || s.admin || 'No admin'} · {isLegacy(sub) ? '' : `${revLabel(sub)} · `}
                  {ago(sub.submittedAt, now)}
                </small>
              </span>
              <Chip tone={sub.reviewedAt ? 'ok' : 'accent'}>{sub.reviewedAt ? 'Approved ✓' : 'To review'}</Chip>
            </a>
            <a className="btn ghost inbox-pdf" href={`#/store/${s.id}/report/pdf`}>
              PDF
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
