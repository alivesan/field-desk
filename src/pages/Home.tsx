import { useRef, useState } from 'react';
import { newEvent, update, useApp, useSync } from '../lib/db.ts';
import { applyImport, planBackupImport, prepareBackup, readBackup, type PreparedBackup } from '../lib/backup.ts';
import { planSummary, type ImportPlan, type ParsedBackup } from '../lib/backupPlan.ts';
import { missingSummary } from '../lib/evidence.ts';
import { parseGames } from '../lib/games.ts';
import { onSpotCounts } from '../lib/onspot.ts';
import { storeDate } from '../lib/recce.ts';
import { homeBuckets, homeReports, type CampaignRow, type HomeBuckets, type HomeStore, type RecceRow, type RecceState } from '../lib/home.ts';
import { groupOfDate, shortDay } from '../lib/weekends.ts';
import { isLiveNow, nextEventDate, storeStages, whenLabel, winnersMissing } from '../lib/stages.ts';
import { seedDemo } from '../lib/demo.ts';
import type { Store } from '../lib/types.ts';
import { go } from '../lib/router.ts';
import { cx, downloadBlob, fmtDate, fmtDateTime, todayLocal } from '../lib/util.ts';
import { askConfirm, Chip, Field, notify, PageHead, Shell, toast, useNow } from '../components/ui.tsx';
import { CountUp, EmptyCard, Ring, StageTrack } from '../components/flair.tsx';
import { storeShortName } from '../lib/names.ts';
import { useStoreName } from '../components/useStoreName.ts';
import { PhoneAccess } from '../components/PhoneAccess.tsx';
import { ReportsInbox } from '../components/ReportsInbox.tsx';
import '../styles/evidence.css';
import '../styles/onspot.css';

export function Home() {
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const [form, setForm] = useState<null | { name: string; date: string; games: string }>(null);
  const list = Object.values(events);
  const now = useNow(60000);
  const today = todayLocal(new Date(now));
  const home = homeBuckets({ events, stores }, today);

  const create = () => {
    if (!form?.name.trim()) return;
    const ev = newEvent({ name: form.name.trim(), date: form.date || todayLocal(), games: parseGames(form.games) });
    update((d) => (d.events[ev.id] = ev));
    toast('Campaign created');
    go(`/event/${ev.id}`);
  };

  return (
    <Shell>
      <i className="hq-wide" hidden />
      <PageHead kicker="Tournament operations" title="Every venue, ready on the day." deck="Store recce with timestamped, geotagged proof — then attendance, the bracket, and who plays next on tournament day." />

      <TodayStrip />

      <section className="index hc-section">
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
          <Campaigns campaigns={home.campaigns} />
        ) : (
          !form && (
            <EmptyCard mark="campaign" title="No campaigns yet." hint="A campaign is a set of stores playing on one date. Create the first one, or load a demo to look around.">
              <button className="btn accent" onClick={() => setForm({ name: '', date: todayLocal(), games: '' })}>
                New campaign
              </button>
              <button
                className="link"
                onClick={() => {
                  go(`/event/${seedDemo()}`);
                  toast('Demo campaign added');
                }}
              >
                Load a demo campaign →
              </button>
            </EmptyCard>
          )
        )}
      </section>

      {list.length > 0 && (
        <>
          <RecceTodo todo={home.recceTodo} />
          <ThisWeekend week={home.thisWeekend} next={home.nextWeekendLabel} />
          <ReportsInbox />
        </>
      )}

      <PhoneAccess />

      <DataTools showDemo={list.length > 0} />
    </Shell>
  );
}

/** A store's short name (the shared prefix dropped), as a row title. */
function StoreTitle({ store }: { store: Store }) {
  const { short } = useStoreName(store);
  return <h3 className="hs-name">{short}</h3>;
}

/** The admin's name, or the store team when only its link exists. */
const peopleOf = (s: Store) => s.admin || (s.access ? 'Store team' : 'No admin yet');

type OpenState = Exclude<RecceState, 'reviewed'>;
const RECCE_CHIP: Record<OpenState, { tone: 'muted' | 'warn' | 'accent'; text: string }> = {
  'not-started': { tone: 'muted', text: 'Not started' },
  'in-progress': { tone: 'warn', text: 'In progress' },
  sent: { tone: 'accent', text: 'Sent — review it' },
};

/** The stores whose recce HQ is waiting on: next weekend's (else the nearest one coming), and this weekend's that are still open. */
function RecceTodo({ todo }: { todo: HomeBuckets['recceTodo'] }) {
  const open = todo.groups.reduce((n, g) => n + g.rows.length, 0);
  const plural = todo.total === 1 ? '' : 's';
  return (
    <section className="hs hs-recce" aria-label="Recce to do">
      <header className="hs-head">
        <h2>Recce to do</h2>
        {todo.label && <span className="label">{todo.isNext ? 'Next weekend' : 'Nearest weekend'} · {todo.label}</span>}
      </header>
      {open === 0 ? (
        <p className="ev-none">{todo.total ? `All ${todo.total} recce${plural} for ${todo.label} ${todo.total === 1 ? 'is' : 'are'} reviewed.` : 'No recces waiting — no store has a coming weekend yet.'}</p>
      ) : (
        <div className="hs-groups">
          {todo.groups
            .filter((g) => g.rows.length)
            .map((g) => (
              <div key={g.state} className={cx('hs-group', g.state)}>
                <h4>
                  {RECCE_CHIP[g.state].text} <b>{g.rows.length}</b>
                </h4>
                <ol className="hs-rows">
                  {g.rows.map((r) => (
                    <RecceItem key={r.store.id} row={r} />
                  ))}
                </ol>
              </div>
            ))}
        </div>
      )}
      {todo.reviewed > 0 && (
        <p className="hs-done">
          <Chip tone="ok">{todo.reviewed} reviewed</Chip>
          <span>
            of {todo.total} store{plural} for {todo.label}
          </span>
        </p>
      )}
    </section>
  );
}

function RecceItem({ row }: { row: RecceRow }) {
  const { store, event, date } = row;
  const chip = RECCE_CHIP[row.state];
  return (
    <li className={cx('hs-row', row.urgent && 'urgent')}>
      <div className="hs-main">
        <StoreTitle store={store} />
        <span className="hs-meta">
          <b>{shortDay(date)}</b>
          {store.city && <span>{store.city}</span>}
          <span>{peopleOf(store)}</span>
          <span className="hs-camp">{event.name}</span>
        </span>
      </div>
      <div className="hs-side">
        {row.urgent && <Chip tone="accent">This weekend!</Chip>}
        <Chip tone={chip.tone}>{chip.text}</Chip>
        {row.state === 'sent' ? (
          <a className="btn" href={`#/store/${store.id}/report`}>
            Review report
          </a>
        ) : (
          <a className="btn ghost" href={`#/event/${event.id}`}>
            Campaign
          </a>
        )}
      </div>
    </li>
  );
}

/** Only this weekend's events (a weekday event of the week joins them), by day, each store one row with its timeline. */
function ThisWeekend({ week, next }: { week: HomeBuckets['thisWeekend']; next: string }) {
  return (
    <section className="hs hs-now" aria-label={week.title}>
      <header className="hs-head">
        <h2>{week.title}</h2>
        <span className="label">{week.range}</span>
      </header>
      {week.days.length === 0 ? (
        <p className="ev-none">{next ? `Nothing this weekend — next: ${next}.` : 'Nothing this weekend.'}</p>
      ) : (
        week.days.map((d) => (
          <div key={d.date} className="hs-day">
            <h4>
              {d.label}{' '}
              <b>
                {d.stores.length} store{d.stores.length === 1 ? '' : 's'}
              </b>
            </h4>
            <ol className="hs-rows fd-stagger">
              {d.stores.map((x, i) => (
                <WeekendItem key={x.store.id} x={x} i={i} />
              ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}

function WeekendItem({ x: { store, event }, i }: { x: HomeStore; i: number }) {
  const live = isLiveNow(store);
  return (
    <li className={cx('hs-row', 'wk', live && 'on')} style={{ ['--i' as string]: i }}>
      <div className="hs-main">
        <StoreTitle store={store} />
        <span className="hs-meta">
          {store.city && <span>{store.city}</span>}
          <span className="hs-camp">{event.name}</span>
          {live && (
            <span className="hs-live">
              <span className="today-dot fd-pulse" aria-hidden /> Live now
            </span>
          )}
        </span>
      </div>
      <StageTrack stages={storeStages(store)} className="hs-track" />
      <div className="hs-side">
        <a className="btn ghost" href={`#/store/${store.id}/players`}>
          Players & bracket
        </a>
        <a className="btn" href={`#/store/${store.id}/day`}>
          Match day
        </a>
      </div>
    </li>
  );
}

/** Current & upcoming campaigns first, each with this weekend's and next weekend's stores; Past is folded away. */
function Campaigns({ campaigns }: { campaigns: HomeBuckets['campaigns'] }) {
  return (
    <>
      {campaigns.current.length > 0 ? <CurrentCampaigns rows={campaigns.current} /> : <p className="ev-none">No current or upcoming campaigns.</p>}
      {campaigns.past.length > 0 && (
        <details className="hc-past">
          <summary>
            Past <b>{campaigns.past.length}</b>
          </summary>
          <PastCampaigns rows={campaigns.past} />
        </details>
      )}
    </>
  );
}

const countStores = (n: number) => `${n} store${n === 1 ? '' : 's'}`;

function CurrentCampaigns({ rows }: { rows: CampaignRow[] }) {
  return (
    <div className="hc">
      <h4 className="hc-title">
        Current & upcoming <b>{rows.length}</b>
      </h4>
      <ol className="hc-list fd-stagger">
        {rows.map((c, i) => {
          const names = c.stores.map((s) => s.name);
          return (
            <li key={c.event.id} className="hc-camp" style={{ ['--i' as string]: i }}>
              <div className="hc-top">
                <a className="hc-main" href={`#/event/${c.event.id}`}>
                  <span className="ev-name">{c.event.name}</span>
                  <span className="ev-meta">
                    {c.range} · {countStores(c.stores.length)}
                    {c.done > 0 && ` · ${c.done} done`}
                    {c.later > 0 && ` · ${c.later} later`}
                  </span>
                </a>
                {c.stores.length > 0 && <Ring value={c.progress} size={40} label={`${Math.round(c.progress * 100)} percent of the steps done across ${countStores(c.stores.length)}`} />}
                <a className="btn ghost hc-open" href={`#/event/${c.event.id}`}>
                  Open campaign
                </a>
              </div>
              {c.weekends.map((w) => (
                <div key={w.label} className={cx('hc-wk', w.when)}>
                  <span className="hc-when">
                    <b>{w.title}</b> {w.label}
                  </span>
                  <ul className="hc-places" aria-label={`${w.title}: ${countStores(w.stores.length)}`}>
                    {w.stores.map((s) => (
                      <li key={s.id}>{storeShortName(s.name, names)}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Past campaigns: one line each. */
function PastCampaigns({ rows }: { rows: CampaignRow[] }) {
  return (
    <div className="hc">
      <ol className="hc-list">
        {rows.map((c) => (
          <li key={c.event.id}>
            <a href={`#/event/${c.event.id}`}>
              <span className="hc-main">
                <span className="ev-name">{c.event.name}</span>
                <span className="ev-meta">
                  {c.range} · {countStores(c.stores.length)}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** HQ's "today / next up" strip: the next event day, what is live right now and what is waiting on HQ. */
function TodayStrip() {
  const events = useApp((s) => s.events);
  const all = useApp((s) => s.stores);
  const now = useNow(60000);
  const stores = Object.values(all).filter((s) => events[s.eventId]);
  if (!Object.keys(events).length) return null;
  const today = todayLocal(new Date(now));
  const dates = [...stores.map((s) => storeDate(s, events[s.eventId])), ...Object.values(events).filter((e) => !stores.some((s) => s.eventId === e.id)).map((e) => e.date)];
  const next = nextEventDate(dates, today);
  // The next event day is part of this weekend (or this week): count the whole weekend's stores, not just that day's.
  const week = homeBuckets({ events, stores: all }, today).thisWeekend;
  const inWeek = !!next && !next.past && groupOfDate(next.date, today) === 'this';
  const counted = inWeek ? week.days.flatMap((d) => d.stores.map((x) => x.store)) : next ? stores.filter((s) => storeDate(s, events[s.eventId]) === next.date) : [];
  const campaigns = [...new Set(counted.length ? counted.map((s) => events[s.eventId].name) : Object.values(events).filter((e) => e.date === next?.date).map((e) => e.name))];
  const live = stores.filter(isLiveNow).length;
  const reports = homeReports({ events, stores: all }, today).length; // the ones in the Recce reports box below
  const walkIns = onSpotCounts(stores).todo;
  const winners = stores.filter(winnersMissing).length;
  const soon = !!next && !next.past && next.days <= 1;

  return (
    <section className="today fd-enter" aria-label="Today and next up">
      <div className="today-tile">
        <span className="label">{next?.past ? 'Last event' : 'Next up'}</span>
        {next ? (
          <>
            <span className="today-date">{fmtDate(next.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className={cx('today-when', soon && 'near', next.past && 'past')}>{whenLabel(next.days)}</span>
            <span className="today-sub">
              {counted.length ? `${counted.length} store${counted.length === 1 ? '' : 's'}${inWeek ? ` ${week.title.toLowerCase()}` : ''} · ` : ''}
              {campaigns.join(', ')}
            </span>
          </>
        ) : (
          <span className="today-sub">No event date yet.</span>
        )}
      </div>
      <div className={cx('today-tile', live === 0 && 'zero')}>
        <span className="today-n">
          {live > 0 && <span className="today-dot fd-pulse" aria-hidden />}
          <CountUp value={live} />
        </span>
        <span className="label">{live === 1 ? 'Store live now' : 'Stores live now'}</span>
      </div>
      <button type="button" className={cx('today-tile', reports === 0 && 'zero')} onClick={() => document.querySelector('.inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        <span className="today-n">
          <CountUp value={reports} />
        </span>
        <span className="label">{reports === 1 ? 'Recce report to review' : 'Recce reports to review'}</span>
      </button>
      <div className={cx('today-tile', walkIns === 0 && 'zero')}>
        <span className="today-n">
          <CountUp value={walkIns} />
        </span>
        <span className="label">{walkIns === 1 ? 'Walk-in to add' : 'Walk-ins to add'}</span>
      </div>
      <a className={cx('today-tile', winners === 0 && 'zero')} href="#/winners">
        <span className="today-n">
          <CountUp value={winners} />
        </span>
        <span className="label">{winners === 1 ? 'Winner missing details' : 'Winners missing details'}</span>
      </a>
    </section>
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
    toast('Backup downloaded');
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
