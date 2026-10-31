import { useMemo, useState, type ReactNode } from 'react';
import { discardWork, sendCommand, useApp, usePendingWork, useSync } from '../lib/db.ts';
import { applyCommand, dayVersion, type Command, type CommandContext } from '../lib/commands.ts';
import { buildBracket, matchNo, roundCount, roundName } from '../lib/bracket.ts';
import { cleanIgn, isPhone, MAX_IGN, normalizePhone, playerIdFor } from '../lib/phone.ts';
import { storeFinished } from '../lib/done.ts';
import { storeDate } from '../lib/recce.ts';
import type { Match, MatchDay, OnSpotEntry, Player, Store, TournamentEvent } from '../lib/types.ts';
import { cx, fmtDate } from '../lib/util.ts';
import { askConfirm, Chip, NotFound, NumberField, PageHead, Shell, toast } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { AutoCheck, ToornamentImport } from '../components/ToornamentImport.tsx';
import { RosterImport } from '../components/RosterImport.tsx';
import { OnSpotList } from '../components/OnSpotList.tsx';
import { PublicBracketLink } from '../components/PublicBracketLink.tsx';
import { ResetWinners } from './WinnersPage.tsx';
import { useStoreName } from '../components/useStoreName.ts';
import { onSpotByPlayer, onSpotOf, prettyPhone } from '../lib/onspot.ts';
import '../styles/day.css';
import '../styles/setup.css';
import '../styles/onspot.css';
import '../styles/done.css';

/*
 * HQ inside one store: 01 Players (import / add / remove — the list order is the seed order)
 * → 02 Bracket (build from that order, reset). Each change is a server command — players.set,
 * bracket.build, bracket.reset — HQ-only and checked against the current state.
 * Admins never see this page; they run the day on the match-day page.
 */

type Step = 'players' | 'bracket';

const underway = (day: MatchDay) => day.matches.some((m) => !m.bye && m.status !== 'pending');
const bySeed = (players: Player[]) => [...players].sort((a, b) => a.seed - b.seed);
const walkInTitle = (e: OnSpotEntry) => `Registered at the desk${e.by ? ` by ${e.by}` : ''} · ${e.toornament ? 'added to Toornament' : 'not added to Toornament yet'}`;

export function StoreSetupPage({ storeId }: { storeId: string }) {
  const store = useApp((s) => s.stores[storeId]);
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const all = useApp((s) => s.stores);
  const campaign = useMemo(() => Object.values(all).filter((s) => s.eventId === store?.eventId), [all, store?.eventId]);
  const { short, prefix } = useStoreName(store);
  const { role } = useSync();
  // Opens on the bracket once there is one, else the players — then stays put (a load or a reset
  // doesn't move the page to another step).
  const [step, setStep] = useState<Step | null>(() => (store ? (store.day.matches.length ? 'bracket' : 'players') : null));
  if (!store || !event || role !== 'super') return <NotFound />;

  const day = store.day;
  const started = underway(day);
  const current: Step = step ?? (day.matches.length ? 'bracket' : 'players');
  const steps: { key: Step; n: string; title: string; status: string; done: boolean }[] = [
    { key: 'players', n: '01', title: 'Players', done: day.players.length > 0, status: day.players.length ? `${day.players.length} players` : 'None yet' },
    { key: 'bracket', n: '02', title: 'Bracket', done: day.matches.length > 0, status: day.players.length < 2 ? 'Needs players' : !day.matches.length ? 'Not built' : started ? 'Under way' : 'Built · not started' },
  ];

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: event.name, href: `#/event/${event.id}` }, { label: short }, { label: 'Players & bracket' }]}>
      <i className="hq-wide" hidden />
      <PageHead kicker={`Players & bracket · ${event.name}`} title={short}>
        <p className="deck setup-meta">
          {prefix && <>{prefix} · </>}
          {fmtDate(storeDate(store, event), { weekday: 'long', day: 'numeric', month: 'long' })}
          {store.city && ` · ${store.city}`}
          {store.admin ? ` · admin ${store.admin}` : ' · no admin assigned'} · <a href={`#/store/${store.id}/day`}>Match day →</a>
        </p>
      </PageHead>

      <nav className="setup-steps" role="tablist">
        {steps.map((s) => (
          <button key={s.key} role="tab" aria-selected={current === s.key} className={cx('setup-step', current === s.key && 'on', s.done && 'done')} onClick={() => setStep(s.key)}>
            <span className="setup-n">{s.done ? '✓' : s.n}</span>
            <span className="setup-title">{s.title}</span>
            <small>{s.status}</small>
          </button>
        ))}
      </nav>

      <Work store={store} />
      <FinishPanel store={store} event={event} />
      <PublicBracketLink store={store} />
      {current === 'players' && <PlayersStep store={store} event={event} campaign={campaign} onNext={() => setStep('bracket')} />}
      {current === 'bracket' && <BracketStep store={store} event={event} onBack={() => setStep('players')} />}
    </Shell>
  );
}

/* ---------- sending commands (checked here first, like the server will) ---------- */

function useRun(store: Store, event: TournamentEvent) {
  const sync = useSync();
  const [problem, setProblem] = useState('');
  const run = (cmd: Command, done?: string) => {
    setProblem('');
    const ctx: CommandContext = { commandId: 'hq-precheck', now: new Date().toISOString(), actor: { principal: sync.principal ?? 'super', name: sync.name ?? 'HQ', role: 'super' }, event };
    try {
      applyCommand(store, cmd, ctx);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      return false;
    }
    try {
      sendCommand(store.id, cmd);
      if (done) toast(done);
      return true;
    } catch (e) {
      setProblem(`Couldn’t queue this on the device: ${(e as Error).message}`);
      return false;
    }
  };
  const notice = problem ? <p className="setup-problem">{problem}</p> : null;
  return { run, notice };
}

const SETUP: Record<string, string> = { 'event.finish': 'Finished', 'event.reopen': 'Reopen', 'players.set': 'Players', 'players.seed': 'Seeding', 'bracket.build': 'Bracket', 'bracket.reset': 'Bracket reset', 'bracket.load': 'Players & bracket', 'onspot.mark': 'On-spot' };

/** This store's setup commands still on their way, or refused by the server. */
function Work({ store }: { store: Store }) {
  const work = usePendingWork(store.id).filter((w) => w.kind === 'cmd' && w.cmd && w.cmd.type in SETUP);
  const { connection } = useSync();
  if (!work.length) return null;
  return (
    <ul className="setup-work">
      {work.map((w) => (
        <li key={w.id} className={cx(w.state === 'failed' || w.state === 'conflict' ? 'bad' : '')}>
          <b>{SETUP[w.cmd!.type]}</b> —{' '}
          {w.state === 'queued' || w.state === 'sending'
            ? connection === 'offline'
              ? 'saved on this device, sends when back online'
              : 'sending…'
            : `${w.state === 'conflict' ? 'refused' : 'couldn’t be sent'}: ${w.error ?? 'no reason given'}`}
          {(w.state === 'failed' || w.state === 'conflict') && (
            <>
              {' '}
              <button className="link" onClick={() => discardWork(w.id)}>
                Dismiss
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ---------- event finished ---------- */

/** Whether this store's event is over: by itself (final played, winner details saved) or marked by HQ — with the buttons for it. */
function FinishPanel({ store, event }: { store: Store; event: TournamentEvent }) {
  const { run, notice } = useRun(store, event);
  const fin = storeFinished(store, event);
  const mark = async () => {
    if (await askConfirm(`Mark ${store.name} as finished? It shows as Finished for HQ and the store’s team. Use it when the event is over but the winner details were never saved here; Reopen takes it back.`, { ok: 'Mark event finished' }))
      run({ type: 'event.finish', base: dayVersion(store) }, 'Marked finished ✓');
  };
  const reopen = async () => {
    if (await askConfirm(`Reopen ${store.name}? It stops showing as finished${fin.finished && store.finishedAt ? ' (unless its final is played and the winner details are saved)' : ''}.`, { ok: 'Reopen' }))
      run({ type: 'event.reopen', base: dayVersion(store) }, 'Reopened');
  };
  return (
    <section className={cx('finish-panel', fin.finished && 'done')} aria-label="Event finished">
      {notice}
      <h2>{fin.finished ? 'Event finished ✓' : 'Event not finished yet'}</h2>
      <p>
        {fin.how === 'auto'
          ? `The final is played and the winner details are saved, so this store finished by itself${fin.at ? ` (${fmtDate(fin.at, { day: 'numeric', month: 'short' })})` : ''}.`
          : fin.how === 'manual'
            ? `Marked finished by ${fin.by || 'HQ'} on ${fmtDate(fin.at, { day: 'numeric', month: 'short' })}. The store’s team sees “Event finished — thank you!”.`
            : 'It finishes by itself once the final is played and the winner details are saved. If the event ended some other way, mark it finished yourself.'}
      </p>
      <div className="finish">
        {!fin.finished && (
          <button className="btn accent" onClick={mark}>
            Mark event finished
          </button>
        )}
        {store.finishedAt && (
          <button className="btn ghost" onClick={reopen}>
            Reopen
          </button>
        )}
      </div>
    </section>
  );
}

/* ---------- 01 Players ---------- */

function PlayersStep({ store, event, campaign, onNext }: { store: Store; event: TournamentEvent; campaign: Store[]; onNext: () => void }) {
  const { run, notice } = useRun(store, event);
  const day = store.day;
  const locked = underway(day);
  const players = bySeed(day.players);
  const walkIns = onSpotByPlayer(day);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [ign, setIgn] = useState('');
  const [ask, setAsk] = useState<null | { existing: Player; kind: 'phone' | 'name' }>(null);
  const [badPhone, setBadPhone] = useState(false);
  const [importing, setImporting] = useState(!players.length);
  const showImport = !locked && (importing || !players.length);

  const setPlayers = (next: Player[], done: string) => run({ type: 'players.set', base: dayVersion(store), players: next.map((p, i) => ({ ...p, seed: i + 1 })) }, done);

  const add = (how: 'new' | 'replace' | 'both' = 'new') => {
    const n = name.replace(/\s+/g, ' ').trim();
    const digits = phone.trim() ? normalizePhone(phone) : '';
    if (!n) return;
    if (phone.trim() && !isPhone(phone)) return setBadPhone(true);
    if (how === 'new') {
      const samePhone = digits ? players.find((p) => p.phone === digits) : undefined;
      if (samePhone) return setAsk({ existing: samePhone, kind: 'phone' });
      const sameName = players.find((p) => p.name.toLowerCase() === n.toLowerCase());
      if (sameName) return setAsk({ existing: sameName, kind: 'name' });
    }
    let list = players;
    let nm = n;
    if (how === 'replace' && ask) list = players.filter((p) => p.id !== ask.existing.id);
    if (how === 'both' && ask?.kind === 'name') nm = `${n} (2)`;
    const shared = how === 'both' && ask?.kind === 'phone';
    const p: Player = { id: shared ? playerIdFor(undefined, `${digits} ${nm}`) : playerIdFor(digits || undefined, nm), name: nm, seed: list.length + 1 };
    if (digits) p.phone = digits;
    const tag = cleanIgn(ign).slice(0, MAX_IGN);
    if (tag && tag.toLowerCase() !== nm.toLowerCase()) p.ign = tag;
    if (how === 'replace' && ask) {
      // same position (seed) as the one it replaces
      const at = players.findIndex((x) => x.id === ask.existing.id);
      list = [...players.slice(0, at), p, ...players.slice(at + 1)];
    } else list = [...list, p];
    if (setPlayers(list, 'Player added')) {
      setName('');
      setPhone('');
      setIgn('');
      setAsk(null);
    }
  };

  const remove = async (p: Player) => {
    if (day.checkIn[p.id] && !(await askConfirm(`${p.name} is checked in. Remove them anyway?`, { ok: 'Remove', danger: true }))) return;
    setPlayers(
      players.filter((x) => x.id !== p.id),
      'Player removed',
    );
  };
  const removeAll = async () => {
    if (await askConfirm(`Remove all ${players.length} players from ${store.name}?`, { ok: 'Remove all', danger: true })) setPlayers([], 'All players removed');
  };

  return (
    <section className="setup-section fd-enter">
      {notice}
      {locked && <p className="setup-lock">Matches are under way, so the players are locked. Reset the bracket (step 2) to change them.</p>}
      {day.matches.length > 0 && !locked && <p className="hint">Changing the players clears the bracket (it hasn’t started) — build it again in step 2.</p>}
      {onSpotOf(day).length > 0 && <OnSpotList event={event} stores={[store]} single />}

      {players.length ? (
        <div className="setup-head">
          <h2>{players.length} players</h2>
          {!locked && (
            <button className="btn ghost" onClick={() => setImporting((v) => !v)}>
              {showImport ? 'Hide import' : 'Replace from a CSV / sheet'}
            </button>
          )}
        </div>
      ) : (
        <EmptyCard compact mark="players" title="No players yet." hint="Upload a CSV, link a published sheet or paste the list below — or add one player at a time further down." />
      )}

      {showImport && <RosterImport event={event} stores={[store]} campaign={campaign} single onLoaded={() => setImporting(false)} />}
      {players.length > 1 && <p className="hint">The list order is the seed order (the file’s order, or its Seed column): seed 1 is the strongest, top seeds get the byes.</p>}

      {players.length > 0 && (
        <ol className="setup-roster">
          {players.map((p) => (
            <li key={p.id}>
              <span className="sr-seed">{p.seed}</span>
              <span className="sr-name">
                {p.name}
                {p.ign && (
                  <span className="ign" title="In-game name">
                    {' '}
                    · {p.ign}
                  </span>
                )}
                {walkIns.has(p.id) && (
                  <span className="os-tag" title={walkInTitle(walkIns.get(p.id)!)}>
                    On spot
                  </span>
                )}
              </span>
              <span className={cx('sr-phone', !p.phone && 'none')}>{p.phone ? prettyPhone(p.phone) : 'no phone'}</span>
              <span className="sr-state">{day.checkIn[p.id] ? (day.checkInSource?.[p.id] === 'self' ? 'Here · QR' : 'Here') : ''}</span>
              {!locked && (
                <button className="link sr-remove" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {!locked && (
        <form
          className="setup-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <span className="label">Add one player</span>
          <div className="setup-add-row">
            <input placeholder="Name" value={name} onChange={(e) => (setName(e.target.value), setAsk(null))} />
            <input type="tel" inputMode="tel" placeholder="Phone" value={phone} onChange={(e) => (setPhone(e.target.value), setAsk(null), setBadPhone(false))} />
            <input placeholder="In-game name (optional)" aria-label="In-game name (optional)" maxLength={MAX_IGN} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={ign} onChange={(e) => setIgn(e.target.value)} />
            <button className="btn" disabled={!name.trim()}>
              Add
            </button>
          </div>
          {badPhone && <p className="hint warn">That isn’t a phone number.</p>}
          {ask && (
            <fieldset className="rq">
              <legend>
                {ask.kind === 'phone' ? `That number is already ${ask.existing.name}’s — which one is it?` : `There’s already a “${ask.existing.name}” — which one is it?`}
              </legend>
              <button type="button" className="rq-opt" onClick={() => (setAsk(null), setName(''), setPhone(''), setIgn(''))}>
                <span>
                  <b>{ask.existing.name}</b>
                  <small>Keep the one on the list (don’t add)</small>
                </span>
              </button>
              <button type="button" className="rq-opt" onClick={() => add('replace')}>
                <span>
                  <b>{name.trim()}</b>
                  <small>Replace {ask.existing.name} with this</small>
                </span>
              </button>
              <button type="button" className="rq-opt" onClick={() => add('both')}>
                <span>
                  <b>Both</b>
                  <small>{ask.kind === 'phone' ? 'They share this number (they’ll check in at the desk, not by QR)' : `Different people — the new one becomes “${name.trim()} (2)”`}</small>
                </span>
              </button>
            </fieldset>
          )}
        </form>
      )}

      <div className="submit-bar">
        {!locked && players.length > 0 && (
          <button className="link warn" onClick={removeAll}>
            Remove all players
          </button>
        )}
        {players.length >= 2 && (
          <button className="btn accent" onClick={onNext}>
            Next: bracket →
          </button>
        )}
      </div>
    </section>
  );
}

/** "1 · Asha vs 8 · Dev" for round one, using the real seeding rules. */
function firstRound(list: Player[]) {
  if (list.length < 2) return [];
  const seeded = list.map((p, i) => ({ ...p, seed: i + 1 }));
  const name = new Map(seeded.map((p) => [p.id, `${p.seed} · ${p.name}`]));
  return buildBracket(seeded, null, 'preview')
    .filter((m) => m.round === 0)
    .sort((a, b) => a.index - b.index)
    .map((m) => ({ a: m.a ? name.get(m.a)! : 'Bye', b: m.b ? name.get(m.b)! : 'Bye' }));
}

/* ---------- 02 Bracket ---------- */

function BracketStep({ store, event, onBack }: { store: Store; event: TournamentEvent; onBack: () => void }) {
  const { run, notice } = useRun(store, event);
  const day = store.day;
  const [stations, setStations] = useState<number | null>(day.stations);
  const played = day.matches.filter((m) => !m.bye && m.status === 'done').length;
  const live = day.matches.filter((m) => m.status === 'live').length;

  const reset = async () => {
    const lost = [played && `${played} result${played === 1 ? '' : 's'}`, live && `${live} live match${live === 1 ? '' : 'es'}`].filter(Boolean).join(' and ');
    const what = lost ? `${lost} will be cleared. ` : '';
    if (!(await askConfirm(`Reset the bracket at ${store.name}? ${what}Players (in their order) and check-ins stay — you can change them and build again.`, { ok: 'Reset bracket', danger: true }))) return;
    run({ type: 'bracket.reset', base: dayVersion(store) }, 'Bracket reset');
  };

  if (!day.matches.length && day.players.length < 2)
    return (
      <>
        <ToornamentImport store={store} event={event} />
        <section className="setup-section fd-enter">
          <EmptyCard compact mark="bracket" title="No bracket yet." hint="Fetch it from Toornament above, or add at least 2 players in step 1 and build it from that list.">
            <button className="btn ghost" onClick={onBack}>
              Go to players
            </button>
          </EmptyCard>
        </section>
      </>
    );

  if (!day.matches.length) {
    const preview = firstRound(bySeed(day.players));
    return (
      <>
        <ToornamentImport store={store} event={event} />
        <section className="setup-section fd-enter">
          {notice}
          <div className="setup-head">
            <h2>Or build it from the player list</h2>
          </div>
          <p className="hint">
            {day.players.length} players in the order of the player list (seed 1 first), single elimination.{' '}
            <button className="link" onClick={onBack}>
              Change players
            </button>
          </p>
          <div className="setup-preview">
            <span className="label">First round</span>
            <ol>
              {preview.map((m, i) => (
                <li key={i}>
                  {m.a} <em>vs</em> {m.b}
                </li>
              ))}
            </ol>
          </div>
          <NumberField label="Stations (matches at once)" value={stations} min={1} max={64} onChange={setStations} />
          <div className="submit-bar">
            <span />
            <button className="btn accent" onClick={() => run({ type: 'bracket.build', base: dayVersion(store), stations: stations ?? day.stations }, 'Bracket created')}>
              Create bracket
            </button>
          </div>
        </section>
      </>
    );
  }

  return (
    <section className="setup-section fd-enter">
      {notice}
      <div className="setup-head">
        <h2>Bracket</h2>
        <Chip tone={played || live ? 'accent' : 'ok'}>{played || live ? `${played} played · ${live} live` : 'Not started'}</Chip>
      </div>
      <AutoCheck store={store} event={event} />
      <BracketChart day={day} />
      {day.winners && (
        <p className="hint">
          Winner and runner-up details are saved for this store. <ResetWinners store={store} link />
        </p>
      )}
      <div className="submit-bar">
        <a className="btn ghost" href={`#/store/${store.id}/day`}>
          Open match day
        </a>
        <button className="btn danger" onClick={reset}>
          Reset bracket
        </button>
      </div>
    </section>
  );
}

/** Read-only bracket, same look as the match-day page. */
function BracketChart({ day }: { day: MatchDay }) {
  const names = Object.fromEntries(day.players.map((p) => [p.id, p.name]));
  const igns: Record<string, string | undefined> = Object.fromEntries(day.players.map((p) => [p.id, p.ign]));
  const total = roundCount(day.matches);
  const rounds = Array.from({ length: total }, (_, r) => day.matches.filter((m) => m.round === r).sort((a, b) => a.index - b.index));
  const slot = (m: Match, id: string | null): ReactNode => (
    <div className={cx('bslot', m.winner && m.winner === id && 'won', m.winner && id && m.winner !== id && 'lost')}>
      <span title={id && igns[id] ? `In-game name: ${igns[id]}` : undefined}>{id ? names[id] : m.round === 0 && m.bye ? 'Bye' : 'TBD'}</span>
    </div>
  );
  return (
    <div className="bracket-scroll">
      <div className="bracket" style={{ ['--rounds' as string]: total }}>
        {rounds.map((list, r) => (
          <div key={r} className="bround">
            <div className="label">{roundName(r, total)}</div>
            <div className="bround-list">
              {list.map((m) => (
                <div key={m.id} className={cx('bmatch', m.status, m.bye && 'bye')}>
                  <div className="bmatch-top">
                    <span>M{matchNo(m, day.matches)}</span>
                    {m.status === 'live' && <Chip tone="accent">Stn {m.station}</Chip>}
                    {m.score && <span>{m.score}</span>}
                  </div>
                  {slot(m, m.a)}
                  {slot(m, m.b)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
