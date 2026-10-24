import { useEffect, useState } from 'react';
import { newStore, update, useApp } from '../lib/db.ts';
import { assignStore } from '../lib/admins.ts';
import type { Admin } from '../lib/types.ts';
import { assess, verdictLabel } from '../lib/assess.ts';
import { parseGames, sameGames } from '../lib/games.ts';
import { submissionLabel, submissionState } from '../lib/submission.ts';
import { computeQueue } from '../lib/bracket.ts';
import { go } from '../lib/router.ts';
import { ago, fmtDate } from '../lib/util.ts';
import { dateSpan, storeDate } from '../lib/recce.ts';
import { askConfirm, Chip, Field, NotFound, NumberField, PageHead, Progress, Shell, toast, useNow } from '../components/ui.tsx';
import { EmptyCard, StageTrack } from '../components/flair.tsx';
import { storeStages } from '../lib/stages.ts';
import { sharedPrefix, storePrefix, storeShortName } from '../lib/names.ts';
import { detailsOf, StoreForm, type StoreDetails } from '../components/StoreForm.tsx';
import { applyToornamentLink, HH_MM } from '../lib/toornament.ts';
import { autoFrom } from '../lib/toornament-auto.ts';
import { RosterImport } from '../components/RosterImport.tsx';
import { StoreSheetImport } from '../components/StoreSheetImport.tsx';
import { OnSpotList } from '../components/OnSpotList.tsx';
import { EventWinners } from './WinnersPage.tsx';
import { onSpotCounts } from '../lib/onspot.ts';
import { StoreTeamLink } from '../components/StoreTeamLink.tsx';
import { SteamAssign } from '../components/SteamAssign.tsx';
import '../styles/evidence.css';
import '../styles/storesheet.css';

export function EventPage({ eventId }: { eventId: string }) {
  const event = useApp((s) => s.events[eventId]);
  const all = useApp((s) => s.stores);
  const adminsById = useApp((s) => s.admins);
  const admins = Object.values(adminsById).sort((a, b) => a.name.localeCompare(b.name));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [settings, setSettings] = useState(false);
  const now = useNow(20000);
  if (!event) return <NotFound />;

  const stores = Object.values(all)
    .filter((s) => s.eventId === eventId)
    .sort((a, b) => storeDate(a, event).localeCompare(storeDate(b, event)) || a.name.localeCompare(b.name));
  const edit = (fn: (e: typeof event) => void) => update((d) => fn(d.events[eventId]));
  // Stores go by their short name; what they all share ("ASUS ROG Exclusive Store") is said once, above the list.
  const storeNames = stores.map((s) => s.name);
  const shared = sharedPrefix(storeNames);

  const save = (storeId: string | null, d: StoreDetails) => {
    const fields = { name: d.name, city: d.city.trim(), state: d.state.trim(), exclusive: d.exclusive, date: d.date, phone: d.phone.trim(), address: d.address.trim(), mapsUrl: d.mapsUrl.trim(), venue: d.venue.trim(), geo: d.geo };
    let id = storeId;
    if (!id) {
      const s = newStore(event.id, fields);
      applyToornamentLink(s, d.toornamentUrl);
      id = s.id;
      update((x) => (x.stores[s.id] = s));
    } else
      update((x) => {
        Object.assign(x.stores[id!], fields);
        applyToornamentLink(x.stores[id!], d.toornamentUrl);
      });
    if ((all[id]?.adminId ?? '') !== d.adminId) assignStore(id, d.adminId || null);
    setAdding(false);
    setEditing(null);
    toast(storeId ? 'Store details saved' : 'Store added');
  };

  const remove = async () => {
    if (!(await askConfirm(`Delete “${event.name}” and all ${stores.length} store(s)? Photos stay in this browser’s storage until cleared.`, { ok: 'Delete campaign', danger: true }))) return;
    update((d) => {
      delete d.events[eventId];
      for (const s of stores) delete d.stores[s.id];
    });
    toast('Campaign deleted');
    go('/');
  };

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: event.name }]}>
      <i className="hq-wide" hidden />
      <PageHead kicker={`Campaign · ${dateSpan(event, stores)}`} title={event.name} deck={event.games.length ? event.games.join(' · ') : 'No games set yet — add them in settings.'} />

      <section className="index">
        <div className="index-head">
          <div className="index-title">
            <h2>Stores</h2>
            {shared && <span className="label">{shared}</span>}
          </div>
          <div className="head-actions">
            <button className="btn ghost" onClick={() => setImporting((v) => !v)}>
              {importing ? 'Hide import' : 'Import from a sheet'}
            </button>
            <button className="btn" onClick={() => setAdding(true)}>
              Add store
            </button>
          </div>
        </div>

        {importing && <StoreSheetImport event={event} stores={stores} admins={admins} onClose={() => setImporting(false)} />}

        {adding && <StoreForm initial={detailsOf(undefined, event.date)} admins={admins} submitLabel="Add store" onSave={(d) => save(null, d)} onCancel={() => setAdding(false)} />}

        <ol className="stores fd-stagger">
          {stores.map((s, i) => {
            const a = assess(event, s);
            const sub = submissionState(s, []); // HQ's view of the server state — another device's outbox isn't visible here
            const q = s.day.matches.length ? computeQueue(s.day) : null;
            const names = Object.fromEntries(s.day.players.map((p) => [p.id, p.name]));
            const walkIns = onSpotCounts([s]);
            return (
              <li key={s.id} className="store-row" style={{ ['--i' as string]: i }}>
                <div className="store-main">
                  {!shared && storePrefix(s.name, storeNames) && <span className="label store-kicker">{storePrefix(s.name, storeNames)}</span>}
                  <h3>{storeShortName(s.name, storeNames)}</h3>
                  <span className="label">{[fmtDate(storeDate(s, event), { weekday: 'short', day: 'numeric', month: 'short' }), [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>
                  {s.exclusive && (
                    <div className="store-tags">
                      <Chip>ROG Exclusive</Chip>
                    </div>
                  )}
                  <div className="store-people">
                    {/* The store team's shared link comes first; a named admin is optional (someone covering several stores). */}
                    <StoreTeamLink store={s} />
                    <AdminSelect admins={admins} value={s.adminId && adminsById[s.adminId] ? s.adminId : ''} onChange={(v) => assignStore(s.id, v || null)} />
                    <SteamAssign store={s} />
                  </div>
                  {s.updatedAt && <span className="label updated">Updated {ago(s.updatedAt, now)}</span>}
                  <button className="link" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                    {!s.address || !s.mapsUrl ? 'Add address & Maps link' : 'Edit details'}
                  </button>
                </div>
                <div className="store-status">
                  <div>
                    <span className="label">Recce</span>
                    <div className="row tight">
                      <Chip tone={a.verdict === 'ready' ? 'ok' : a.verdict === 'attention' ? 'warn' : 'muted'}>{verdictLabel(a.verdict, !!sub.acknowledged && !sub.edited)}</Chip>
                      {sub.acknowledged && <Chip tone={sub.kind === 'reviewed' ? 'ok' : sub.edited ? 'warn' : undefined}>{submissionLabel(sub)}</Chip>}
                    </div>
                    <Progress value={a.progress} tone={a.verdict === 'ready' ? 'ok' : undefined} />
                  </div>
                  <div>
                    <span className="label">Match day</span>
                    <div className="store-day">
                      {q ? (q.champion ? `Won by ${names[q.champion]}` : `${Object.keys(s.day.checkIn).length}/${s.day.players.length} here · ${q.live.length} live`) : s.day.players.length ? `${s.day.players.length} players · no bracket yet` : 'No players yet'}
                    </div>
                    {walkIns.total > 0 && (
                      <a className="os-badge" href={`#/store/${s.id}/players`} title="Walk-ins registered at the desk — to add to Toornament">
                        <Chip tone={walkIns.todo ? 'warn' : 'ok'}>{walkIns.todo ? `${walkIns.todo} on-spot to add` : `${walkIns.total} on-spot · all added`}</Chip>
                      </a>
                    )}
                  </div>
                </div>
                <div className="store-actions">
                  <a className="btn ghost" href={`#/store/${s.id}/recce`}>
                    Recce
                  </a>
                  <a className="btn ghost" href={`#/store/${s.id}/report`}>
                    Report
                  </a>
                  <a className="btn ghost" href={`#/store/${s.id}/players`}>
                    Players & bracket
                  </a>
                  <a className="btn" href={`#/store/${s.id}/day`}>
                    Match day
                  </a>
                </div>
                <StageTrack stages={storeStages(s)} />
                {editing === s.id && (
                  <div className="store-edit">
                    <StoreForm initial={detailsOf(s, event.date)} admins={admins} submitLabel="Save" onSave={(d) => save(s.id, d)} onCancel={() => setEditing(null)} />
                  </div>
                )}
              </li>
            );
          })}
          {!stores.length && !adding && (
            <li className="empty-li">
              <EmptyCard mark="stores" title="No stores yet." hint="Add the venues for this campaign one by one, or bring them all in from a sheet.">
                <button className="btn accent" onClick={() => setAdding(true)}>
                  Add store
                </button>
                <button className="link" onClick={() => setImporting(true)}>
                  Import from a sheet →
                </button>
              </EmptyCard>
            </li>
          )}
        </ol>
      </section>

      {stores.length > 0 && <EventWinners event={event} stores={stores} />}

      {stores.length > 0 && <OnSpotList event={event} stores={stores} />}

      {stores.length > 1 && (
        <section className="data-tools">
          <button className="link" onClick={() => setBulk((v) => !v)}>
            {bulk ? 'Hide' : 'One player file for several stores'}
          </button>
          {bulk && <RosterImport event={event} stores={stores} />}
        </section>
      )}

      <section className="data-tools">
        <button className="link" onClick={() => setSettings((v) => !v)}>
          {settings ? 'Hide' : 'Campaign settings'}
        </button>
        {settings && (
          <div className="card form">
            <Field label="Campaign name" value={event.name} onChange={(v) => edit((e) => (e.name = v))} />
            <div className="grid2">
              <Field label="Default date (each store can have its own)" type="date" value={event.date} onChange={(v) => edit((e) => (e.date = v))} />
              <GamesField games={event.games} onCommit={(g) => edit((e) => (e.games = g))} />
            </div>
            <p className="hint">The games are the laptop checklist: every game station must have each one installed and launched. Changing them changes what every store still has to tick — reports already submitted keep the list they were sent with.</p>
            <div className="grid2">
              <NumberField label="Laptops that need games installed" value={event.gameReadyTarget} min={1} max={20} onChange={(v) => edit((e) => (e.gameReadyTarget = v ?? 1))} />
              <NumberField label="Minimum download (Mbps)" value={event.minDownMbps} max={1000} onChange={(v) => edit((e) => (e.minDownMbps = v ?? 0))} />
            </div>
            <p className="hint">Changing the laptop target applies to laptop lists the next time their count is edited.</p>
            <div className="grid2">
              <Field
                label="Check Toornament for the bracket from (India time)"
                type="time"
                value={autoFrom(event)}
                onChange={(v) =>
                  edit((e) => {
                    if (HH_MM.test(v)) e.toornamentAuto = { from: v };
                    else if (!v) delete e.toornamentAuto;
                  })
                }
              />
            </div>
            <p className="hint">On each store’s day, from this time the server looks at the store’s Toornament link every 5 minutes. Once the players are placed in a single-elimination bracket it loads it into the store (unless matches are under way or the bracket was built by hand), then stops. Each store has its own on/off under Players &amp; bracket.</p>
            <div className="row end">
              <button className="link warn" onClick={remove}>
                Delete campaign
              </button>
            </div>
          </div>
        )}
      </section>
    </Shell>
  );
}

/**
 * Comma-separated games, edited as text and committed on blur / Enter — parsing every
 * keystroke would swallow the comma before the next game could be typed.
 */
function GamesField({ games, onCommit }: { games: string[]; onCommit: (games: string[]) => void }) {
  const [text, setText] = useState(games.join(', '));
  const [focused, setFocused] = useState(false);
  // Follow changes from elsewhere while not editing.
  useEffect(() => {
    if (!focused) setText(games.join(', '));
  }, [games, focused]);
  const commit = () => {
    const next = parseGames(text);
    setText(next.join(', '));
    if (!sameGames(next, games)) onCommit(next);
  };
  return (
    <label className="field">
      <span className="label">Games (comma separated)</span>
      <input
        value={text}
        placeholder="Valorant, Tekken 8"
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}

function AdminSelect({ admins, value, onChange }: { admins: Admin[]; value: string; onChange: (adminId: string) => void }) {
  // Optional since store team links: only for someone covering several stores. Not a warning when empty.
  if (!admins.length && !value) return null;
  return (
    <select className="assign" aria-label="Also assign a person (optional)" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Also assign a person (optional)</option>
      {admins.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {a.code}
        </option>
      ))}
    </select>
  );
}
