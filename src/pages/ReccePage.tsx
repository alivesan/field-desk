import { useEffect, useState, type ReactNode } from 'react';
import { SteamCard } from '../components/SteamCard.tsx';
import { discardWork, resizeLaptops, retryWork, sendCommand, updateStore, useApp, usePendingWork, useSync } from '../lib/db.ts';
import { storeCrumbs } from '../lib/admins.ts';
import { assess, type SectionKey, type SectionStatus } from '../lib/assess.ts';
import { submissionVersion } from '../lib/commands.ts';
import { ensureRecce, laptopsLostOnResize, readRecce } from '../lib/recce.ts';
import { isLegacy, revLabel, submissionLabel, submissionState } from '../lib/submission.ts';
import type { Laptop, PhotoRef, Recce, Store, TournamentEvent } from '../lib/types.ts';
import { success, warn } from '../lib/haptics.ts';
import { cx, fmtDateTime } from '../lib/util.ts';
import { askConfirm, Check, Choice, Field, notify, NotFound, NumberField, PageHead, Shell, YesNoField } from '../components/ui.tsx';
import { useStoreName } from '../components/useStoreName.ts';
import { BigTick, SegBar } from '../components/flair.tsx';
import { LocationCheck, PhotoSlot } from '../components/PhotoSlot.tsx';
import { SpeedTest } from '../components/SpeedTest.tsx';
import { PrintEntry } from '../components/PrintEntry.tsx';
import '../styles/evidence.css';

const ORDER: SectionKey[] = ['venue', 'furniture', 'laptops', 'network', 'collateral'];

export function ReccePage({ storeId }: { storeId: string }) {
  const store = useApp((s) => s.stores[storeId]);
  const { short: storeName } = useStoreName(store);
  const { role } = useSync();
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const [open, setOpen] = useState<SectionKey | 'notes' | null | undefined>(undefined);
  const [sentBase, setSentBase] = useState<number | null>(null); // the revision count when Submit was pressed here: shows the "sent" card
  const pending = usePendingWork(storeId);
  if (!store || !event) return <NotFound />;

  const r = readRecce(store.recce);
  const a = assess(event, store);
  const st = submissionState(store, pending);
  const sec = (k: SectionKey) => a.sections.find((s) => s.key === k)!;
  const edit = (fn: (r: Recce, s: Store) => void) =>
    updateStore(store.id, (s) => {
      ensureRecce(s.recce);
      s.recce.startedAt ??= new Date().toISOString();
      fn(s.recce, s);
    });

  // Start on the first section with work left.
  const current = open === undefined ? (a.sections.find((s) => !s.done)?.key ?? null) : open;
  const toggle = (k: SectionKey | 'notes') => {
    const next = current === k ? null : k;
    setOpen(next);
    if (next) requestAnimationFrame(() => document.getElementById(next)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const nextOf = (k: SectionKey) => {
    const i = ORDER.indexOf(k);
    return i < ORDER.length - 1 ? ORDER[i + 1] : 'notes';
  };

  /** Photo list updater for a slot: applied to the list as it is in current state (see PhotoSlot). */
  const photosOf = (pick: (r: Recce) => PhotoRef[]) => (fn: (photos: PhotoRef[]) => void) => edit((r) => fn(pick(r)));

  // Submitting is a server command: it is "Submitted" only once the server has it.
  const canSubmit = st.kind === 'draft' || (st.kind === 'failed' && st.work?.state === 'conflict') || ((st.kind === 'submitted' || st.kind === 'reviewed') && isLegacy(st.acknowledged));
  const submit = async () => {
    const left = a.sections.filter((s) => !s.done).length;
    if (left && !(await askConfirm(`${left} section(s) are still incomplete. Submit anyway?`, { ok: 'Submit anyway' }))) return;
    try {
      if (st.work && st.kind === 'failed') discardWork(st.work.id); // a conflicted submit is replaced by this one
      sendCommand(store.id, { type: 'recce.submit', base: submissionVersion(store) });
    } catch (e) {
      void notify(`Couldn’t queue the submission: ${(e as Error).message}`);
      return;
    }
    setSentBase(submissionVersion(store));
    window.scrollTo({ top: 0 });
  };
  const submitText =
    st.kind === 'waiting'
      ? 'Waiting to send…'
      : st.kind === 'failed' && st.work?.state !== 'conflict'
        ? 'Not sent'
        : !canSubmit
          ? submissionLabel(st)
          : st.acknowledged
            ? isLegacy(st.acknowledged)
              ? 'Re-submit to HQ'
              : `Submit update (rev ${(st.acknowledged.rev ?? 0) + 1})`
            : 'Submit to HQ';

  const props = (k: SectionKey, n: number) => ({ n, s: sec(k), open: current === k, onToggle: () => toggle(k), onNext: () => toggle(nextOf(k)) });

  if (sentBase !== null)
    return (
      <Shell crumbs={storeCrumbs(role, event, store, { label: 'Recce' })}>
        <PageHead kicker={`Store recce · ${event.name}`} title={storeName} />
        <SentCard store={store} st={st} base={sentBase} home={role === 'super' ? `#/event/${event.id}` : '#/'} onEdit={() => setSentBase(null)} />
      </Shell>
    );

  return (
    <Shell crumbs={storeCrumbs(role, event, store, { label: 'Recce' })}>
      <PageHead kicker={`Store recce · ${event.name}`} title={storeName}>
        <dl className="info">
          <div>
            <dt>Address</dt>
            <dd>
              {store.address || <span className="muted">HQ will add this</span>}
              {store.mapsUrl && (
                <a className="maps" href={store.mapsUrl} target="_blank" rel="noreferrer">
                  Open in Maps ↗
                </a>
              )}
            </dd>
          </div>
          {store.phone && (
            <div>
              <dt>Store phone</dt>
              <dd>
                <a href={`tel:${store.phone.replace(/[^\d+]/g, '')}`}>{store.phone}</a>
              </dd>
            </div>
          )}
          <div>
            <dt>Venue spot</dt>
            <dd>{store.venue || <span className="muted">HQ will add this</span>}</dd>
          </div>
          <div>
            <dt>Admin</dt>
            <dd>{store.admin || <span className="muted">{role === 'super' ? 'Not assigned — assign on the campaign page' : '—'}</span>}</dd>
          </div>
        </dl>
      </PageHead>

      <LocationCheck />

      <nav className="recce-nav">
        <div className="recce-nav-top">
          <span className="label">
            {a.sections.filter((s) => s.done).length} of {a.sections.length} done
          </span>
          <SubmitStatus st={st} />
        </div>
        <SegBar segments={ORDER.map((k) => ({ key: k, label: sec(k).title, done: sec(k).done, current: current === k, onPick: () => toggle(k) }))} />
      </nav>

      <Section {...props('venue', 1)}>
        {store.venue && <p className="context">{store.venue}</p>}
        <PhotoSlot store={store} label="Play area" hint="A wide shot of where the tournament will happen" photos={r.venue.photos} update={photosOf((r) => r.venue.photos)} />
      </Section>

      <Section {...props('furniture', 2)}>
        <Choice
          label="Setup at the venue"
          value={r.furniture.setup}
          onChange={(v) => edit((r) => (r.furniture.setup = v))}
          options={[
            { value: 'rog', label: 'ROG setup' },
            { value: 'standard', label: 'Standard desk' },
            { value: 'none', label: 'Nothing yet' },
          ]}
        />
        <div className="pair">
          <Field label="Chairs" placeholder="Gaming, office, plastic…" value={r.furniture.chairType} onChange={(v) => edit((r) => (r.furniture.chairType = v))} />
          <NumberField label="How many" value={r.furniture.chairCount} onChange={(v) => edit((r) => (r.furniture.chairCount = v))} />
        </div>
        {r.furniture.setup === 'standard' && <YesNoField label="Tablecloth on the desks" value={r.furniture.tablecloth} onChange={(v) => edit((r) => (r.furniture.tablecloth = v))} />}
        <PhotoSlot store={store} label="The setup" hint="Tables, chairs and laptops as they’ll be on the day" photos={r.furniture.photos} update={photosOf((r) => r.furniture.photos)} />
      </Section>

      <Section {...props('laptops', 3)}>
        <SteamCard store={store} />
        <Laptops event={event} store={store} laptops={r.laptops} edit={edit} />
      </Section>

      <Section {...props('network', 4)}>
        <div className="pair">
          <YesNoField label="Wi-Fi" value={r.network.wifi} onChange={(v) => edit((r) => (r.network.wifi = v))} />
          <YesNoField label="LAN cable" value={r.network.lan} onChange={(v) => edit((r) => (r.network.lan = v))} />
        </div>
        <SpeedTest value={r.network.speed} minDown={event.minDownMbps} onChange={(v) => edit((r) => (r.network.speed = v))} />
        <PhotoSlot
          store={store}
          label="Speed result"
          optional={r.network.speed?.method !== 'manual'}
          hint={r.network.speed?.method === 'manual' ? 'Screenshot of the result you typed in' : 'Optional — the in-app test is already proof'}
          photos={r.network.photos}
          update={photosOf((r) => r.network.photos)}
        />
      </Section>

      <Section {...props('collateral', 5)}>
        <PrintEntry store={store} line />
        <Check checked={r.collateral.posters} onChange={(v) => edit((r) => (r.collateral.posters = v))} hint="Keep them with you — they go to the promotion team (or you, if you’re promoting)">
          Posters printed
        </Check>
        <Check checked={r.collateral.standee} onChange={(v) => edit((r) => (r.collateral.standee = v))}>
          Standee placed at the store
        </Check>
        <Check checked={r.collateral.cheque} onChange={(v) => edit((r) => (r.collateral.cheque = v))}>
          Prize cheque placed at the store
        </Check>
        <PhotoSlot store={store} label="Standee" hint="Where it’s placed in the store" photos={r.collateral.standeePhotos} update={photosOf((r) => r.collateral.standeePhotos)} />
        {!r.collateral.chequeInStandeePhoto && (
          <PhotoSlot store={store} label="Prize cheque" hint="Where it’s placed" photos={r.collateral.chequePhotos} update={photosOf((r) => r.collateral.chequePhotos)} />
        )}
        {!r.collateral.chequePhotos.length && (
          <label className="inline-check">
            <input type="checkbox" checked={r.collateral.chequeInStandeePhoto} onChange={(e) => edit((r) => (r.collateral.chequeInStandeePhoto = e.target.checked))} />
            The standee photo shows the cheque too
          </label>
        )}
      </Section>

      <section className={cx('acc', current === 'notes' && 'open')} id="notes">
        <button className="acc-head" onClick={() => toggle('notes')} aria-expanded={current === 'notes'}>
          <span className="acc-n">06</span>
          <h2>Notes for HQ</h2>
          <span className="acc-state">{r.summary ? 'Added' : 'Optional'}</span>
          <span className="acc-chev" aria-hidden />
        </button>
        {current === 'notes' && (
          <div className="acc-body">
            <Field label="Anything HQ should know" multiline value={r.summary} placeholder="Risks, things you need from us, anything odd" onChange={(v) => edit((r) => (r.summary = v))} />
          </div>
        )}
      </section>

      <div className="submit-bar">
        <a className="btn ghost" href={`#/store/${store.id}/report`}>
          Preview report
        </a>
        <button className="btn accent" onClick={submit} disabled={!canSubmit}>
          {submitText}
        </button>
      </div>
    </Shell>
  );
}

/** After Submit: the big "sent" moment. It says "Sent to HQ" only once the server has the revision; until then it says it is sending, or why it isn't. */
function SentCard({ store, st, base, home, onEdit }: { store: Store; st: ReturnType<typeof submissionState>; base: number; home: string; onEdit: () => void }) {
  const acked = (st.kind === 'submitted' || st.kind === 'reviewed') && submissionVersion(store) > base;
  const failed = st.kind === 'failed';
  useEffect(() => {
    if (acked) success();
    else if (failed) warn();
  }, [acked, failed]);
  const a = st.acknowledged;
  return (
    <section className={cx('sent-card', failed && 'warn', !acked && !failed && 'wait')} role="status">
      {acked ? <BigTick /> : failed ? <BigTick tone="warn" /> : <span className="sending-dot fd-pulse" aria-hidden />}
      {acked ? (
        <>
          <h2>Sent to HQ{a && !isLegacy(a) ? <span className="sent-rev"> · {revLabel(a)}</span> : null}</h2>
          <p>HQ will check it and open match day for you. If you change anything later, the recce shows “edited since” until you send the update.</p>
        </>
      ) : failed ? (
        <>
          <h2>Not sent</h2>
          <p>{st.work?.state === 'conflict' ? 'It was submitted from another device meanwhile. Check the recce and submit again.' : `${st.work?.error ?? 'The server refused it.'} Your answers are safe on this device.`}</p>
        </>
      ) : (
        <>
          <h2>Sending to HQ…</h2>
          <p>Saved on this device. It goes the moment there’s signal.</p>
        </>
      )}
      <div className="row">
        {acked ? (
          <>
            <a className="btn accent" href={home}>
              {home === '#/' ? 'Back to my stores' : 'Back to the campaign'}
            </a>
            <a className="btn ghost" href={`#/store/${store.id}/report`}>
              View the report
            </a>
          </>
        ) : failed && st.work && st.work.state !== 'conflict' ? (
          <button className="btn accent" onClick={() => retryWork(st.work!.id)}>
            Retry
          </button>
        ) : null}
        <button className="link" onClick={onEdit}>
          {acked ? 'Keep editing' : 'Back to the recce'}
        </button>
      </div>
    </section>
  );
}

/** Where the submission stands — the words match AdminHome and the report. */
function SubmitStatus({ st }: { st: ReturnType<typeof submissionState> }) {
  const a = st.acknowledged;
  if (st.kind === 'waiting') return <span className="label warn">Waiting to send — it goes to HQ when there’s signal</span>;
  if (st.kind === 'failed')
    return (
      <span className="label warn ev-failed">
        {st.work?.state === 'conflict' ? 'Not sent — submitted from another device meanwhile; check and submit again' : `Not sent — ${st.work?.error ?? 'the server refused it'}`}
        {st.work && st.work.state !== 'conflict' && (
          <button className="link" onClick={() => retryWork(st.work!.id)}>
            Retry
          </button>
        )}
      </span>
    );
  if (st.kind === 'reviewed') return <span className="label ok">Reviewed by HQ · {revLabel(a!)} sent {fmtDateTime(a!.submittedAt)}</span>;
  if (st.kind === 'submitted') return <span className="label ok">{isLegacy(a) ? 'Submitted' : `Submitted · ${revLabel(a!)}`} {fmtDateTime(a!.submittedAt)}</span>;
  if (a) return <span className="label warn">Edited since {revLabel(a)} — submit the update so HQ sees it</span>;
  return <span className="label">Draft — not sent to HQ yet</span>;
}

function Section({ n, s, open, onToggle, onNext, children }: { n: number; s: SectionStatus; open: boolean; onToggle: () => void; onNext: () => void; children: ReactNode }) {
  return (
    <section className={cx('acc', open && 'open', s.done && 'done')} id={s.key}>
      <button className="acc-head" onClick={onToggle} aria-expanded={open}>
        <span className="acc-n">{String(n).padStart(2, '0')}</span>
        <h2>{s.title}</h2>
        <span className="acc-state">{s.done ? (s.issues.length ? 'Done · note' : 'Done') : `${s.todo.length} left`}</span>
        <span className="acc-chev" aria-hidden />
      </button>
      {open && (
        <div className="acc-body">
          {children}
          {(s.todo.length > 0 || s.issues.length > 0) && (
            <ul className="todo">
              {s.todo.map((t) => (
                <li key={t}>{t}</li>
              ))}
              {s.issues.map((t) => (
                <li key={t} className="warn">
                  {t}
                </li>
              ))}
            </ul>
          )}
          <button className="link next" onClick={onNext}>
            {s.done ? 'Next section →' : 'Skip for now →'}
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- laptops: one at a time ---------- */

function Laptops({ event, store, laptops, edit }: { event: TournamentEvent; store: Store; laptops: Laptop[]; edit: (fn: (r: Recce) => void) => void }) {
  const [sel, setSel] = useState(0);
  const target = event.gameReadyTarget;
  const i = Math.min(sel, Math.max(0, laptops.length - 1));
  const l = laptops[i];
  const checks = (x: Laptop) => [...event.games.flatMap((g) => [!!x.games[g], !!x.launched?.[g]]), x.drivers, x.windows, x.photos.length > 0];
  const state = (x: Laptop) => {
    if (x.role !== 'game') return 'other';
    const c = checks(x);
    return c.every(Boolean) ? 'done' : c.some(Boolean) ? 'partial' : 'todo';
  };
  // Edit this laptop by id in the current state — never by a position captured earlier.
  const set = (fn: (l: Laptop) => void) =>
    edit((r) => {
      const x = r.laptops.find((y) => y.id === l.id);
      if (x) fn(x);
    });
  const resize = async (n: number | null) => {
    const count = n ?? 0;
    const lost = laptopsLostOnResize(laptops, count);
    if (lost.length && !await askConfirm(`Going down to ${count} laptop(s) removes ${lost.map((x) => x.label).join(', ')} — with their checks${lost.some((x) => x.photos.length) ? ', notes and proof photos' : ' and notes'}. Remove them?`, { ok: 'Remove', danger: true })) return;
    edit((r) => (r.laptops = resizeLaptops(r.laptops, count, target)));
  };

  return (
    <>
      <div className="lap-count">
        <NumberField label="Laptops at the store" value={laptops.length || null} onChange={resize} max={40} />
        <p className="hint">
          Install the games on the first {target}, even if fewer get played. Laptop {String(target + 1).padStart(2, '0')} is the admin PC.
        </p>
      </div>

      {laptops.length > 0 && (
        <>
          <div className="lap-tabs" role="tablist">
            {laptops.map((x, j) => (
              <button key={x.id} role="tab" aria-selected={j === i} className={cx('lap-tab', state(x), j === i && 'on')} onClick={() => setSel(j)}>
                <span>{String(j + 1).padStart(2, '0')}</span>
                <small>{x.role === 'game' ? (state(x) === 'done' ? 'Ready' : `${checks(x).filter(Boolean).length}/${checks(x).length}`) : x.role === 'admin' ? 'Admin' : 'Spare'}</small>
              </button>
            ))}
          </div>

          <div className="lap-panel">
            <div className="lap-head">
              <strong>{l.label}</strong>
              <span className="label">{l.role === 'game' ? 'Game station' : l.role === 'admin' ? 'Admin PC' : 'Spare'}</span>
            </div>
            {l.role === 'game' ? (
              <>
                {event.games.map((g) => (
                  <div key={g} className="game-row">
                    <span className="game-name">{g}</span>
                    <Toggle on={!!l.games[g]} onChange={(v) => set((x) => (x.games[g] = v))}>
                      Installed
                    </Toggle>
                    <Toggle on={!!l.launched?.[g]} onChange={(v) => set((x) => ((x.launched ??= {})[g] = v))}>
                      Launched
                    </Toggle>
                  </div>
                ))}
                {!event.games.length && <p className="hint warn">HQ hasn’t set the games for this campaign yet.</p>}
                <div className="game-row">
                  <span className="game-name">Updates</span>
                  <Toggle on={l.drivers} onChange={(v) => set((x) => (x.drivers = v))}>
                    GPU drivers
                  </Toggle>
                  <Toggle on={l.windows} onChange={(v) => set((x) => (x.windows = v))}>
                    Windows
                  </Toggle>
                </div>
                <PhotoSlot store={store} label={`${l.label} screen`} hint="The screen showing the games installed" photos={l.photos} update={(fn) => set((x) => fn(x.photos))} />
              </>
            ) : (
              <p className="hint">{l.role === 'admin' ? 'Keep this one for running the tournament — no games needed.' : 'Not needed on the day.'}</p>
            )}
            <input className="lap-note" placeholder="Note (optional) — model, issues…" value={l.notes} onChange={(e) => set((x) => (x.notes = e.target.value))} />
            {i < laptops.length - 1 && laptops[i + 1].role === 'game' && (
              <button className="link next" onClick={() => setSel(i + 1)}>
                Laptop {String(i + 2).padStart(2, '0')} →
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={cx('toggle', on && 'on')} onClick={() => onChange(!on)}>
      <span className="toggle-box" aria-hidden />
      {children}
    </button>
  );
}
