import { useRef, useState } from 'react';
import { newEvent, update, useApp, useSync } from '../lib/db.ts';
import { applyImport, planBackupImport, prepareBackup, readBackup, type PreparedBackup } from '../lib/backup.ts';
import { planSummary, type ImportPlan, type ParsedBackup } from '../lib/backupPlan.ts';
import { missingSummary } from '../lib/evidence.ts';
import { parseGames } from '../lib/games.ts';
import { submissionsOf } from '../lib/submission.ts';
import { onSpotCounts } from '../lib/onspot.ts';
import { seedDemo } from '../lib/demo.ts';
import { go } from '../lib/router.ts';
import { downloadBlob, fmtDate, fmtDateTime, todayLocal } from '../lib/util.ts';
import { askConfirm, Field, notify, PageHead, Shell } from '../components/ui.tsx';
import { PhoneAccess } from '../components/PhoneAccess.tsx';
import { ReportsInbox } from '../components/ReportsInbox.tsx';
import '../styles/evidence.css';
import '../styles/onspot.css';

export function Home() {
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const [form, setForm] = useState<null | { name: string; date: string; games: string }>(null);
  const list = Object.values(events).sort((a, b) => b.date.localeCompare(a.date));

  const create = () => {
    if (!form?.name.trim()) return;
    const ev = newEvent({ name: form.name.trim(), date: form.date || todayLocal(), games: parseGames(form.games) });
    update((d) => (d.events[ev.id] = ev));
    go(`/event/${ev.id}`);
  };

  return (
    <Shell>
      <PageHead kicker="Tournament operations" title="Every venue, ready on the day." deck="Store recce with timestamped, geotagged proof — then attendance, the bracket, and who plays next on tournament day." />

      <PhoneAccess />
      <ReportsInbox />

      <section className="index">
        <div className="index-head">
          <h2>Campaigns</h2>
          <button className="btn" onClick={() => setForm({ name: '', date: todayLocal(), games: '' })}>
            New campaign
          </button>
        </div>

        {form && (
          <div className="card form">
            <Field label="Campaign name" value={form.name} placeholder="e.g. Campus Clash — City Qualifier" onChange={(v) => setForm({ ...form, name: v })} />
            <div className="grid2">
              <Field label="Date" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
              <Field label="Games (comma separated)" value={form.games} placeholder="Valorant, Tekken 8" onChange={(v) => setForm({ ...form, games: v })} />
            </div>
            <div className="row end">
              <button className="btn ghost" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button className="btn accent" onClick={create} disabled={!form.name.trim()}>
                Create campaign
              </button>
            </div>
          </div>
        )}

        {list.length ? (
          <ol className="events">
            {list.map((ev) => {
              const ss = Object.values(stores).filter((s) => s.eventId === ev.id);
              const sent = ss.filter((s) => submissionsOf(s).length > 0).length;
              const walkIns = onSpotCounts(ss).todo;
              return (
                <li key={ev.id}>
                  <a href={`#/event/${ev.id}`}>
                    <span className="ev-date">{fmtDate(ev.date, { day: '2-digit', month: 'short' })}</span>
                    <span className="ev-name">{ev.name}</span>
                    <span className="ev-meta">
                      {ss.length} store{ss.length === 1 ? '' : 's'} · {sent} recce report{sent === 1 ? '' : 's'} in
                      {walkIns > 0 && <span className="ev-onspot"> · {walkIns} on-spot to add to Toornament</span>}
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
        ) : (
          !form && (
            <div className="empty-state">
              <p>No campaigns yet.</p>
              <button className="link" onClick={() => go(`/event/${seedDemo()}`)}>
                Load a demo campaign to look around →
              </button>
            </div>
          )
        )}
      </section>

      <DataTools showDemo={list.length > 0} />
    </Shell>
  );
}

/** Backup export (after an evidence check) and import (validated and previewed before anything changes). */
function DataTools({ showDemo }: { showDemo: boolean }) {
  const sync = useSync();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [prepared, setPrepared] = useState<PreparedBackup | null>(null); // incomplete export, waiting on the user
  const [incoming, setIncoming] = useState<{ name: string; backup: ParsedBackup } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [includeAdmins, setIncludeAdmins] = useState(false);
  const [keepNewer, setKeepNewer] = useState(true);
  const [applied, setApplied] = useState<{ changes: number; photos: number } | null>(null);
  const plan: ImportPlan | null = incoming ? planBackupImport(incoming.backup, { includeAdmins, keepNewerLocal: keepNewer }) : null;

  const download = async (p: PreparedBackup) => {
    const f = await p.build();
    downloadBlob(f, f.name);
  };

  const exportNow = async () => {
    setBusy('export');
    setPrepared(null);
    try {
      const p = await prepareBackup();
      if (p.evidence.complete) await download(p);
      else setPrepared(p);
    } catch (e) {
      void notify(`Couldn’t make the backup: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const exportAnyway = async () => {
    if (!prepared) return;
    setBusy('export');
    try {
      await download(prepared);
      setPrepared(null);
    } catch (e) {
      void notify(`Couldn’t make the backup: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const pick = async (f: File | undefined) => {
    setErrors([]);
    setIncoming(null);
    setApplied(null);
    if (!f) return;
    const r = await readBackup(f);
    if (!r.ok) return setErrors(r.errors);
    setIncludeAdmins(false);
    setKeepNewer(true);
    setIncoming({ name: f.name, backup: r.backup });
  };

  const confirmImport = async () => {
    if (!plan?.ok) return;
    if (includeAdmins && plan.admins.reactivated.length && !(await askConfirm(`Import ${plan.admins.reactivated.length} admin sign-in code(s) from the backup? Their old personal links will work again.`, { ok: 'Import codes' }))) return;
    setBusy('import');
    try {
      setApplied(await applyImport(plan));
      setIncoming(null);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy('');
    }
  };

  // "Imported" only once the server has it — until then the changes are waiting to sync.
  const accepted = !!applied && !sync.pending && !sync.failed && sync.status === 'live';
  const importStatus = !applied
    ? ''
    : !applied.changes && !applied.photos
      ? 'Nothing to import — everything in the file was already here.'
      : sync.failed
        ? `Imported on this device, but the server rejected ${sync.failed} change(s) — see the sync status.`
        : !accepted
          ? `${applied.changes} change(s) and ${applied.photos} photo(s) from the backup are waiting to sync${sync.status === 'live' ? '…' : ' — not connected to the server yet'}.`
          : `Import accepted by the server: ${applied.changes} change(s), ${applied.photos} photo(s).`;

  return (
    <section className="data-tools">
      <h2>Data</h2>
      <p className="hint">Everything syncs to the Field Desk server, so HQ and every admin see the same data live. A backup file is a portable copy of what this device can see, with every proof photo it could load — keep the server’s own database and photo backups too.</p>
      <div className="row">
        <button className="btn ghost" onClick={exportNow} disabled={!!busy}>
          {busy === 'export' ? 'Checking photos…' : 'Export backup'}
        </button>
        <button className="btn ghost" onClick={() => file.current?.click()} disabled={!!busy}>
          Import backup
        </button>
        {showDemo && (
          <button className="link" onClick={() => go(`/event/${seedDemo()}`)}>
            Add demo campaign
          </button>
        )}
      </div>

      {prepared && (
        <div className="ev-prompt" role="alert">
          <strong>The backup would be incomplete.</strong>
          <p>{missingSummary(prepared.evidence)}</p>
          <p className="hint">Photos still uploading from a phone usually arrive within a minute. An incomplete backup says so in its manifest and its file name.</p>
          <div className="row">
            <button className="btn" onClick={exportNow} disabled={!!busy}>
              Retry
            </button>
            <button className="btn ghost" onClick={exportAnyway} disabled={!!busy}>
              Export incomplete backup
            </button>
            <button className="link" onClick={() => setPrepared(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="ev-prompt bad" role="alert">
          <strong>Nothing was imported.</strong>
          <ul>
            {errors.slice(0, 12).map((e) => (
              <li key={e}>{e}</li>
            ))}
            {errors.length > 12 && <li>…and {errors.length - 12} more problem(s)</li>}
          </ul>
        </div>
      )}

      {incoming && plan && (
        <div className="card form ev-import">
          <div>
            <strong>Import “{incoming.name}”?</strong>
            <p className="hint">
              {incoming.backup.exportedAt ? `Exported ${fmtDateTime(incoming.backup.exportedAt)}. ` : 'An older backup, without an evidence manifest. '}
              Nothing has changed yet.
            </p>
          </div>
          {!plan.ok ? (
            <div className="ev-prompt bad">
              <strong>This backup doesn’t pass validation — nothing will be imported.</strong>
              <ul>
                {plan.errors.slice(0, 12).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {plan.errors.length > 12 && <li>…and {plan.errors.length - 12} more</li>}
              </ul>
            </div>
          ) : (
            <>
              <table className="ev-counts">
                <thead>
                  <tr>
                    <th />
                    <th>New</th>
                    <th>Replaced</th>
                    <th>Already here</th>
                    <th>Kept (newer here)</th>
                  </tr>
                </thead>
                <tbody>
                  {(['events', 'stores', 'admins'] as const).map((k) => (
                    <tr key={k}>
                      <th>{k === 'events' ? 'Campaigns' : k === 'stores' ? 'Stores' : 'Admins'}</th>
                      {k === 'admins' && !plan.admins.included ? (
                        <td colSpan={4}>{plan.admins.inFile} in the file — not imported</td>
                      ) : (
                        <>
                          <td>{plan.counts[k].create}</td>
                          <td>{plan.counts[k].replace}</td>
                          <td>{plan.counts[k].same}</td>
                          <td>{plan.counts[k].keptNewer}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.localNewer.length > 0 && (
                <div>
                  <p className="hint warn">
                    {plan.localNewer.length} store(s) changed here after this backup was made: {plan.localNewer.map((x) => x.name).join(', ')}.
                  </p>
                  <label className="inline-check">
                    <input type="checkbox" checked={!keepNewer} onChange={(e) => setKeepNewer(!e.target.checked)} />
                    Overwrite them with the older copy from the backup
                  </label>
                </div>
              )}
              {plan.admins.inFile > 0 && (
                <div>
                  <label className="inline-check">
                    <input type="checkbox" checked={includeAdmins} onChange={(e) => setIncludeAdmins(e.target.checked)} />
                    Also import {plan.admins.inFile} admin(s) and their sign-in codes
                  </label>
                  {includeAdmins && (
                    <p className="hint warn">
                      Restoring codes makes the backup’s personal links work again
                      {plan.admins.reactivated.length ? ` — ${plan.admins.reactivated.map((a) => `${a.name}: ${a.why}`).join('; ')}` : ''}.
                    </p>
                  )}
                </div>
              )}
              {plan.missingPhotos.length > 0 && (
                <p className="hint warn">
                  {plan.missingPhotos.length} referenced photo(s) aren’t in the file and will show as missing unless the server already has them: {plan.missingPhotos.slice(0, 4).map((p) => p.label).join('; ')}
                  {plan.missingPhotos.length > 4 ? '…' : ''}
                </p>
              )}
              {plan.warnings.map((w) => (
                <p key={w} className="hint">
                  {w}
                </p>
              ))}
            </>
          )}
          <div className="row end">
            <button className="btn ghost" onClick={() => setIncoming(null)}>
              Cancel
            </button>
            <button className="btn accent" onClick={confirmImport} disabled={!plan.ok || !plan.edits.length || busy === 'import'}>
              {busy === 'import' ? 'Importing…' : plan.edits.length ? `Import — ${planSummary(plan)}` : 'Nothing to import'}
            </button>
          </div>
        </div>
      )}

      {importStatus && <p className={accepted ? 'hint ok' : 'hint warn'}>{importStatus}</p>}

      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          pick(f);
        }}
      />
    </section>
  );
}

/** @deprecated use parseGames (lib/games.ts) — kept for older imports. */
export const split = parseGames;
