import { useMemo, useState } from 'react';
import { useApp } from '../lib/db.ts';
import { dayVersion } from '../lib/commands.ts';
import type { Store, TournamentEvent } from '../lib/types.ts';
import { go } from '../lib/router.ts';
import { prettyPhone } from '../lib/onspot.ts';
import { FIELD_LABEL } from '../lib/winnerInput.ts';
import { STATUS_LABEL, summarize, winnerRows, winnersCsv, type WinnerRow, type WinnerStatus } from '../lib/winners.ts';
import { cx, downloadBlob, fmtDate, slug, todayLocal } from '../lib/util.ts';
import { askConfirm, Chip, notify, PageHead, Shell, toast } from '../components/ui.tsx';
import { CountUp, EmptyCard } from '../components/flair.tsx';
import { useHqCommand } from '../components/hqCommand.ts';
import '../styles/winners.css';

type StatusFilter = 'all' | WinnerStatus;
const FILTERS: StatusFilter[] = ['all', 'complete', 'partial', 'no-details', 'no-final', 'mismatch'];
const FILTER_LABEL: Record<StatusFilter, string> = { all: 'All', ...STATUS_LABEL, mismatch: 'To check' };
const TONE: Record<WinnerStatus, 'ok' | 'warn' | 'accent' | 'muted'> = { complete: 'ok', partial: 'warn', 'no-details': 'warn', 'no-final': 'muted', mismatch: 'accent' };

const savedAt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One store's two rows (Winner, Runner-up), kept together for the card. */
interface StoreRows {
  storeId: string;
  rows: WinnerRow[];
}

/** HQ: every store's winner and runner-up with their details and the event date, and the CSV for the final. `eventId` = the campaign filter (#/winners/<id>). */
export function WinnersPage({ eventId }: { eventId?: string }) {
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const [status, setStatus] = useState<StatusFilter>('all');
  const campaign = eventId && events[eventId] ? eventId : '';
  const all = useMemo(() => winnerRows({ events, stores }, campaign ? { eventId: campaign } : {}), [events, stores, campaign]);
  const summary = summarize(all);

  // Status filter works per store: a store stays if either of its places has that status, and shows both.
  const groups = useMemo(() => {
    const byStore = new Map<string, StoreRows>();
    for (const r of all) {
      const g = byStore.get(r.storeId) ?? { storeId: r.storeId, rows: [] };
      g.rows.push(r);
      byStore.set(r.storeId, g);
    }
    return [...byStore.values()].filter((g) => status === 'all' || g.rows.some((r) => r.status === status));
  }, [all, status]);
  const shown = groups.flatMap((g) => g.rows);
  const counts = (f: StatusFilter) => (f === 'all' ? summary.stores : new Set(all.filter((r) => r.status === f).map((r) => r.storeId)).size);

  const byCampaign = new Map<string, StoreRows[]>();
  for (const g of groups) byCampaign.set(g.rows[0].eventId, [...(byCampaign.get(g.rows[0].eventId) ?? []), g]);

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: 'Winners' }]}>
      <PageHead kicker="HQ" title="Winners" deck="Every store’s winner and runner-up, with the details the admin collected after the final — and the date of the event. One CSV for the whole lot." />

      <section className="wn-bar">
        <label className="field wn-campaign">
          <span className="label">Campaign</span>
          <select value={campaign} onChange={(e) => go(e.target.value ? `/winners/${e.target.value}` : '/winners')}>
            <option value="">All campaigns</option>
            {Object.values(events)
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name} — {fmtDate(ev.date, { day: 'numeric', month: 'short' })}
                </option>
              ))}
          </select>
        </label>
        <button className="btn accent" onClick={() => downloadWinners(shown, campaign ? events[campaign].name : undefined)} disabled={!shown.length}>
          Download CSV
        </button>
      </section>

      <p className="wn-summary">
        {summary.stores ? (
          <>
            <strong>
              <CountUp value={summary.played} /> of {plural(summary.stores, 'store')}
            </strong>{' '}
            {summary.played === 1 ? 'has' : 'have'} a winner · <strong><CountUp value={summary.full} /></strong> with full details
            {summary.check > 0 && <span className="wn-check"> · {summary.check} to check</span>}
          </>
        ) : (
          'No stores yet.'
        )}
      </p>
      <div className="wn-filters" role="group" aria-label="Show stores by status">
        {FILTERS.map((f) => (
          <button key={f} type="button" className={cx('wn-filter', status === f && 'on')} aria-pressed={status === f} onClick={() => setStatus(f)}>
            {FILTER_LABEL[f]} <span>{counts(f)}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 && status !== 'all' && <p className="hint">Download CSV has the {plural(groups.length, 'store')} shown here, winner and runner-up for each.</p>}

      {!groups.length ? (
        summary.stores ? (
          <EmptyCard mark="winners" title="No stores with that status." hint="Pick another filter to see the rest.">
            <button className="link" onClick={() => setStatus('all')}>
              Show all stores →
            </button>
          </EmptyCard>
        ) : (
          <EmptyCard mark="winners" title="No winners yet." hint="Stores and their winners appear here once campaigns have stores and the finals are played.">
            <a className="link" href="#/">
              Go to the campaigns →
            </a>
          </EmptyCard>
        )
      ) : (
        [...byCampaign.values()].map((list) => (
          <section className="wn-campaign-group" key={list[0].rows[0].eventId}>
            <div className="wn-group-head">
              <h2>
                <a href={`#/event/${list[0].rows[0].eventId}`}>{list[0].rows[0].campaign}</a>
              </h2>
              <span className="label">{plural(list.length, 'store')}</span>
            </div>
            <div className="wn-stores fd-stagger">
              {list.map((g, i) => (
                <StoreCard key={g.storeId} rows={g.rows} index={i} />
              ))}
            </div>
          </section>
        ))
      )}
    </Shell>
  );
}

function StoreCard({ rows, index }: { rows: WinnerRow[]; index: number }) {
  const first = rows[0];
  const store = useApp((s) => s.stores[first.storeId]);
  const open = !first.finalDone && rows.every((r) => r.status === 'no-final');
  return (
    <article className="wn-store" style={{ ['--i' as string]: index }}>
      <header className="wn-store-head">
        <h3>{first.store}</h3>
        <div className="wn-where">
          {[first.city, first.state].filter(Boolean).join(', ') || 'No city'} · <time dateTime={first.date}>{fmtDate(first.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</time>
        </div>
        <div className="wn-links">
          <a href={`#/store/${first.storeId}/players`}>Players &amp; bracket</a>
          <a href={`#/store/${first.storeId}/day`}>Match day</a>
        </div>
      </header>
      {open ? <p className="wn-open">Final not played yet.</p> : <div className="wn-places">{rows.map((r) => <Person key={r.place} row={r} />)}</div>}
      {store?.day.winners && <ResetWinners store={store} />}
    </article>
  );
}

/** HQ: clear the saved details (test data, or a final that was reset). The bracket is not touched; the admin can collect them again. */
export function ResetWinners({ store, link }: { store: Store; link?: boolean }) {
  const send = useHqCommand();
  const reset = async () => {
    if (!(await askConfirm(`Clear the winner and runner-up details saved for ${store.name}? Who won stays in the bracket; the admin can collect the details again.`, { ok: 'Reset winner details', danger: true }))) return;
    const problem = send(store.id, (s) => ({ type: 'winners.clear', base: dayVersion(s) }));
    if (problem) void notify(problem);
    else toast('Winner details reset');
  };
  if (link)
    return (
      <button className="link warn" onClick={reset}>
        Reset winner details
      </button>
    );
  return (
    <div className="wn-reset">
      <button className="btn danger" onClick={reset}>
        Reset winner details
      </button>
    </div>
  );
}

function Person({ row: r }: { row: WinnerRow }) {
  const name = r.realName || r.listName;
  return (
    <section className={cx('wn-person', r.status, r.place === 'Winner' ? 'first' : 'second')}>
      <div className="wn-place">
        <span className="wn-rank" aria-hidden>
          {r.place === 'Winner' ? '1' : '2'}
        </span>
        <span className="label">{r.place}</span>
        <Chip tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Chip>
      </div>
      <div className={cx('wn-name', !r.realName && 'list')}>{name || 'Name not given'}</div>
      {!r.realName && r.listName && r.status !== 'no-details' && <p className="wn-note">Real name not given — on the player list as {r.listName}.</p>}
      {r.ign && <div className="ign">{r.ign}</div>}
      {r.status === 'no-details' && <p className="wn-note">Nothing saved yet — name, phone and in-game name are from the player list.</p>}
      {r.status === 'partial' && <p className="wn-note warn">Missing: {r.missing.map((f) => FIELD_LABEL[f]).join(', ')}</p>}
      {r.status === 'mismatch' && <p className="wn-note bad">{r.note}</p>}
      <dl className="wn-contact">
        <Line label="Phone" value={r.phone} href={`tel:${r.phone}`} text={prettyPhone(r.phone)} />
        <Line label="Email" value={r.email} href={`mailto:${r.email}`} text={r.email} />
        <Line label="Instagram" value={r.instagram} href={`https://instagram.com/${r.instagram}`} text={`@${r.instagram}`} external />
      </dl>
      {r.savedAt && (
        <p className="wn-saved">
          Saved {savedAt(r.savedAt)} · {r.savedBy}
        </p>
      )}
    </section>
  );
}

function Line({ label, value, href, text, external }: { label: string; value: string; href: string; text: string; external?: boolean }) {
  return (
    <div className="wn-line">
      <dt className="label">{label}</dt>
      <dd className={cx(!value && 'none')}>{value ? <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{text}</a> : 'not given'}</dd>
    </div>
  );
}

function downloadWinners(rows: WinnerRow[], campaign?: string) {
  const name = `winners-${campaign ? slug(campaign) : 'all'}-${todayLocal()}.csv`;
  downloadBlob(new Blob([winnersCsv(rows)], { type: 'text/csv;charset=utf-8' }), name); // the text starts with a BOM: Excel reads it as UTF-8
}

/** On a campaign page: how many stores have winners, with the way to the list and the CSV. */
export function EventWinners({ event, stores }: { event: TournamentEvent; stores: Store[] }) {
  const rows = useMemo(() => winnerRows({ events: { [event.id]: event }, stores: Object.fromEntries(stores.map((s) => [s.id, s])) }, { eventId: event.id }), [event, stores]);
  const s = summarize(rows);
  return (
    <section className="wn-event">
      <div>
        <h2>Winners</h2>
        <p>
          {s.played} of {plural(s.stores, 'store')} {s.played === 1 ? 'has' : 'have'} a winner · {s.full} with full details
          {s.check > 0 && <span className="wn-check"> · {s.check} to check</span>}
        </p>
      </div>
      <div className="wn-event-links">
        <a className="btn ghost" href={`#/winners/${event.id}`}>
          View
        </a>
        <button className="btn ghost" disabled={!s.played} onClick={() => downloadWinners(rows, event.name)}>
          Download CSV
        </button>
      </div>
    </section>
  );
}
