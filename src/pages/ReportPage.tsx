import { useEffect, useRef, useState } from 'react';
import { discardWork, sendCommand, useApp, usePendingWork, usePhotoUrls, useSync } from '../lib/db.ts';
import { storeCrumbs } from '../lib/admins.ts';
import { submissionVersion } from '../lib/commands.ts';
import { evidenceBanner, expectedPhotos, missingSummary, type EvidenceBanner, type ManifestResult } from '../lib/evidence.ts';
import { checkRenderedPhotos, loadEvidence, type LoadedEvidence } from '../lib/evidenceLoad.ts';
import { buildReportFile } from '../lib/exportReport.ts';
import { useRoute } from '../lib/router.ts';
import { editedSince, isLegacy, revLabel, submissionIdFor, submissionsOf, submissionState, type AnySubmission } from '../lib/submission.ts';
import { cx, downloadBlob, fmtDate, fmtDateTime } from '../lib/util.ts';
import { askConfirm, NotFound, notify, Shell, toast } from '../components/ui.tsx';
import { useHqCommand } from '../components/hqCommand.ts';
import { Report } from '../components/Report.tsx';
import { markReportSeen } from '../components/ReportsInbox.tsx';
import '../styles/evidence.css';
import '../styles/hq-delete.css';
import '../styles/done.css';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

type Mode = 'pdf' | 'download' | 'share';
/** An export that found missing evidence and is waiting for the user: retry, or go ahead with a banner. */
interface Held {
  mode: Mode;
  result: ManifestResult;
  evidence: LoadedEvidence;
}

export function ReportPage({ storeId }: { storeId: string }) {
  const store = useApp((s) => s.stores[storeId]);
  const { role } = useSync();
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const pending = usePendingWork(storeId);
  const wantPdf = useRoute()[3] === 'pdf'; // the inbox's PDF button: #/store/:id/report/pdf
  const [pick, setPick] = useState<string | null>(null); // submission id, 'draft', or null = default
  const [busy, setBusy] = useState<Mode | ''>('');
  const [held, setHeld] = useState<Held | null>(null);
  const [printBanner, setPrintBanner] = useState<EvidenceBanner | null>(null);
  const [printNote, setPrintNote] = useState<string | undefined>(undefined);
  const printing = useRef(false);
  const send = useHqCommand();

  const subs = store ? submissionsOf(store) : [];
  const st = store ? submissionState(store, pending) : null;
  // HQ opens the latest revision the server has; the admin opens their working draft.
  const fallback = role === 'super' ? (st?.acknowledged?.id ?? subs.at(-1)?.id ?? 'draft') : 'draft';
  const chosen = pick ?? fallback;
  const submission: AnySubmission | undefined = chosen === 'draft' ? undefined : (subs.find((s) => s.id === chosen) ?? subs.at(-1));
  const latest = subs.at(-1);
  const expected = store ? expectedPhotos(submission ? submission.recce : store.recce, store.id) : [];
  const urls = usePhotoUrls(expected.map((e) => e.id));

  // Opening the latest submitted revision as HQ clears its "New" mark in the inbox.
  const seenId = role === 'super' && submission && submission.id === latest?.id ? submission.id : undefined;
  useEffect(() => {
    if (seenId) markReportSeen(storeId, seenId);
  }, [storeId, seenId]);

  /** Fetch + decode every photo this revision shows. For the PDF, also the on-screen <img>s. */
  const check = async (mode: Mode): Promise<Held> => {
    const evidence = await loadEvidence(expected);
    if (mode !== 'pdf' || !evidence.result.complete) return { mode, result: evidence.result, evidence };
    const root = document.querySelector('.report');
    const start = Date.now();
    while (root && Date.now() - start < 8000 && expected.some((e) => !root.querySelector(`img[data-photo-id="${CSS.escape(e.id)}"]`))) await sleep(150);
    return { mode, result: root ? await checkRenderedPhotos(root, expected) : evidence.result, evidence };
  };

  const deliver = async (h: Held) => {
    if (!store || !event) return;
    if (h.mode === 'pdf') {
      if (printing.current) return;
      printing.current = true;
      setPrintBanner(evidenceBanner(h.result)); // an incomplete PDF carries the list of what's missing
      setPrintNote(h.result.complete && h.result.expected ? `All ${h.result.expected} proof photos included.` : undefined);
      await frame();
      await frame();
      await document.fonts.ready;
      const title = document.title;
      document.title = `Recce — ${store.name} — ${event.name}${h.result.complete ? '' : ' (incomplete)'}`;
      window.print();
      document.title = title;
      setPrintBanner(null);
      setPrintNote(undefined);
      printing.current = false;
      return;
    }
    const f = await buildReportFile(event, store, { submission, evidence: h.evidence, draftNote });
    if (h.mode === 'share' && navigator.canShare?.({ files: [f] })) {
      await navigator.share({ files: [f], title: `Recce — ${store.name}`, text: `Store recce report for ${store.name} (${event.name})${h.result.complete ? '' : ' — incomplete: some photos are missing'}` });
    } else downloadBlob(f, f.name);
  };

  const run = async (mode: Mode, anyway?: Held) => {
    setBusy(mode);
    try {
      const h = anyway ?? (await check(mode));
      if (!h.result.complete && !anyway) return setHeld(h);
      setHeld(null);
      await deliver(h);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') void notify((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    if (!wantPdf || !store || !event) return;
    history.replaceState(null, '', `#/store/${storeId}/report`);
    run('pdf');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPdf, !!store, !!event]);

  if (!store || !event || !st) return <NotFound />;

  const edited = !!latest && editedSince(store, latest);
  const unsent = st.kind === 'waiting' || st.kind === 'failed' ? st.work : undefined; // its revision is only optimistic
  const unsentId = unsent ? submissionIdFor(unsent.id) : undefined;
  const draftNote = unsent && (!submission || submission.id === unsentId)
    ? st.kind === 'waiting'
      ? 'Submitted on this device — waiting to send. HQ gets it when there’s signal.'
      : `Not sent to HQ — ${unsent.error ?? 'open the recce to retry'}.`
    : submission
    ? submission.id === latest?.id && edited
      ? `Edited since ${revLabel(submission)} — the admin’s later changes aren’t submitted yet, so they’re not shown here.`
      : undefined
    : latest
      ? `Working draft — ${edited ? `edited since ${revLabel(latest)}, not submitted yet` : `same as ${revLabel(latest)}`}.`
      : 'Working draft — not submitted to HQ yet.';

  // HQ approves a revision (recce.review) or takes the approval back (recce.unreview). Approving is what opens match day for the store team early.
  const approveWork = pending.find((w) => (w.cmd?.type === 'recce.review' || w.cmd?.type === 'recce.unreview') && 'submissionId' in w.cmd && w.cmd.submissionId === submission?.id);
  const approveFailed = approveWork && (approveWork.state === 'failed' || approveWork.state === 'conflict') ? approveWork : undefined;
  const approving = !!approveWork && !approveFailed;
  const approvable = role === 'super' && submission && !isLegacy(submission) && submission.id !== unsentId ? submission : undefined;
  const approve = () => {
    if (!approvable) return;
    try {
      sendCommand(store.id, { type: 'recce.review', base: submissionVersion(store), submissionId: approvable.id });
    } catch (e) {
      void notify(`Couldn’t approve it: ${(e as Error).message}`);
      return;
    }
    toast('Recce approved ✓');
  };
  const undoApproval = async () => {
    if (!approvable) return;
    const text = `Take back the approval of ${revLabel(approvable)} of ${store.name}? The recce goes back to “waiting for HQ”. Match day closes again for the store team unless another revision is approved or it is already the event date.`;
    if (!(await askConfirm(text, { ok: 'Undo approval' }))) return;
    const problem = send(store.id, () => ({ type: 'recce.unreview', base: submissionVersion(store), submissionId: approvable.id }));
    if (problem) void notify(problem);
    else toast('Approval undone');
  };

  // HQ's danger area: delete test data. Photos stay on the server (write-once) but nothing references them any more.
  const removing = pending.find((w) => w.cmd?.type === 'recce.delete' || w.cmd?.type === 'recce.reset');
  const deletable = role === 'super' && submission && !isLegacy(submission) && submission.id !== unsentId ? submission : undefined;
  const deleteRevision = async () => {
    if (!deletable) return;
    const only = subs.length === 1;
    const text = `Delete ${revLabel(deletable)} of ${store.name}, submitted ${fmtDateTime(deletable.submittedAt)}? It leaves the Recce reports for good. ${only ? 'It’s the only revision, so the store goes back to “no report yet”. ' : 'Other revisions stay. '}The admin’s working recce is not touched. Photos already uploaded stay on the server but aren’t shown.`;
    if (!(await askConfirm(text, { ok: `Delete ${revLabel(deletable)}`, danger: true }))) return;
    const problem = send(store.id, () => ({ type: 'recce.delete', base: submissionVersion(store), submissionId: deletable.id }));
    if (problem) void notify(problem);
    else {
      setPick(null);
      toast(`${revLabel(deletable)} deleted`);
    }
  };
  const resetRecce = async () => {
    const n = subs.length;
    const text = `Reset the recce for ${store.name}? This deletes ${n ? `all ${n} submitted revision${n === 1 ? '' : 's'} and ` : ''}everything the admin entered — checks, notes, speed test and photo placements. The admin will have to do the recce again. Photos already uploaded stay on the server but aren’t shown.`;
    if (!(await askConfirm(text, { ok: 'Reset recce', danger: true }))) return;
    const problem = send(store.id, (s) => ({ type: 'recce.reset', base: submissionVersion(s) }));
    if (problem) void notify(problem);
    else {
      setPick(null);
      toast('Recce reset');
    }
  };

  const label = (mode: Mode, text: string) => (busy === mode ? 'Checking photos…' : text);

  return (
    <Shell crumbs={storeCrumbs(role, event, store, { label: 'Report' })}>
      <div className="report-actions no-print">
        <div className="row">
          <a className="btn ghost" href={`#/store/${store.id}/recce`}>
            Edit recce
          </a>
          {subs.length > 0 && (
            <label className="ev-rev">
              <span className="label">Showing</span>
              <select value={submission ? submission.id : 'draft'} onChange={(e) => (setPick(e.target.value), setHeld(null))}>
                {[...subs].reverse().map((s) => (
                  <option key={s.id} value={s.id}>
                    {isLegacy(s) ? 'Submitted report' : `Rev ${s.rev}`} · {s.id === unsentId ? 'not sent yet' : fmtDateTime(s.submittedAt)}
                    {s.reviewedAt ? ' · approved' : ''}
                  </option>
                ))}
                <option value="draft">Working draft (live)</option>
              </select>
            </label>
          )}
        </div>
        <div className="row">
          <button className="btn" onClick={() => run('pdf')} disabled={!!busy}>
            {label('pdf', 'Save as PDF')}
          </button>
          <button className="btn ghost" onClick={() => run('share')} disabled={!!busy}>
            {label('share', 'Share file')}
          </button>
          <button className="link" onClick={() => run('download')} disabled={!!busy}>
            {label('download', 'Download HTML')}
          </button>
        </div>
      </div>

      {approvable && (
        <section className={cx('approve no-print', approvable.reviewedAt && 'done')} aria-label="Recce approval">
          {approvable.reviewedAt ? (
            <>
              <div className="approve-text">
                <strong>Recce approved ✓</strong>
                <span>
                  {fmtDate(approvable.reviewedAt)} by {approvable.reviewedBy || 'HQ'} · {revLabel(approvable)}
                </span>
              </div>
              <button className="btn ghost" onClick={undoApproval} disabled={approving}>
                Undo approval
              </button>
            </>
          ) : (
            <>
              <div className="approve-text">
                <strong>Happy with {revLabel(approvable)}?</strong>
                <span>Approving it tells the store team their recce is accepted, and opens match day for them.</span>
              </div>
              <button className="btn accent big" onClick={approve} disabled={approving}>
                Approve recce
              </button>
            </>
          )}
          {approveFailed && (
            <p className="approve-problem">
              Not saved — {approveFailed.error ?? 'try again'}.{' '}
              <button className="link" onClick={() => discardWork(approveFailed.id)}>
                Dismiss
              </button>
            </p>
          )}
        </section>
      )}

      {held && (
        <div className="ev-prompt no-print" role="alert">
          <strong>Not every proof photo could be loaded.</strong>
          <p>{missingSummary(held.result)}</p>
          <p className="hint">A photo still uploading from the field usually arrives within a minute. If you export anyway, the {held.mode === 'pdf' ? 'PDF' : 'file'} opens with a banner listing what’s missing.</p>
          <div className="row">
            <button className="btn" onClick={() => run(held.mode)} disabled={!!busy}>
              {busy ? 'Checking photos…' : 'Retry'}
            </button>
            <button className="btn ghost" onClick={() => run(held.mode, held)} disabled={!!busy}>
              Export incomplete {held.mode === 'pdf' ? 'PDF' : 'file'}
            </button>
            <button className="link" onClick={() => setHeld(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <Report event={event} store={store} submission={submission} src={(id) => urls[id]} generatedAt={new Date().toISOString()} banner={printBanner} evidenceNote={printNote} draftNote={draftNote} />

      {role === 'super' && (
        <section className="danger-zone no-print">
          <h2>Delete test data</h2>
          <p className="hint">For dummy recces and mistakes. Photos already uploaded stay on the server but aren’t shown. Field admins can’t do this.</p>
          {removing && <p className="label">{removing.state === 'failed' || removing.state === 'conflict' ? `Not deleted — ${removing.error ?? 'try again'}` : 'Deleting…'}</p>}
          <div className="row">
            <button className="btn danger" onClick={deleteRevision} disabled={!deletable || !!removing} title={deletable ? undefined : 'Pick a submitted revision under “Showing” first'}>
              {deletable ? `Delete ${revLabel(deletable)}` : 'Delete this revision'}
            </button>
            <button className="btn danger" onClick={resetRecce} disabled={!!removing}>
              Reset recce for this store
            </button>
          </div>
          {submission && isLegacy(submission) && <p className="hint">This report predates revisions, so it can only be removed by resetting the recce.</p>}
        </section>
      )}
    </Shell>
  );
}
