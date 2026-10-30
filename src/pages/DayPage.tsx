import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SteamCard } from '../components/SteamCard.tsx';
import { discardWork, retryWork, sendCommand, updateStore, useApp, usePendingWork, useSync, type PendingWork } from '../lib/db.ts';
import { storeCrumbs } from '../lib/admins.ts';
import { computeQueue, matchNo, roundCount, roundName } from '../lib/bracket.ts';
import {
  checkInUrl,
  closeSelfCheckIn,
  isSelf,
  matchesPlayer,
  newSelfCheckIns,
  openSelfCheckIn,
  recentSelfCheckIns,
  rotateSelfCheckIn,
  staffCheckIn,
  undoCheckIn,
  withoutPhone,
  type SelfArrival,
} from '../lib/checkin.ts';
import { dayVersion, type Command } from '../lib/commands.ts';
import { isPhone, MAX_IGN, normalizePhone, publicName } from '../lib/phone.ts';
import { differentName, onSpotClash, tournamentCommand } from '../lib/tournament.ts';
import { onSpotByPlayer } from '../lib/onspot.ts';
import { feederOf, KIND_INFO, KIND_ORDER, matchState, maskedPhone, pathOf, phoneTail, roundInPlay, roundShort, slotKind, wireTone, type MatchKind, type SlotKind, type WireTone } from '../lib/day-ui.ts';
import { reducedMotion, useFreshIds } from '../lib/day-fx.ts';
import { success, tap } from '../lib/haptics.ts';
import type { Match, MatchDay, Player, Store, TournamentEvent } from '../lib/types.ts';
import { cx, fmtTime, minutesSince, uid } from '../lib/util.ts';
import { askConfirm, Chip, NotFound, notify, NumberField, PageHead, Shell, toast, useNow } from '../components/ui.tsx';
import { useStoreName } from '../components/useStoreName.ts';
import { MatchSheet, StateTag } from '../components/MatchSheet.tsx';
import { PlayerSheet } from '../components/PlayerSheet.tsx';
import { CheckInQr } from '../components/CheckInQr.tsx';
import { WinnersBanner } from '../components/WinnersBanner.tsx';
import { finalResult } from '../lib/winnerInput.ts';
import '../styles/day.css';
import { shareOrigin, useLan } from '../lib/origin.ts';
import '../styles/checkin.css';

type Tab = 'checkin' | 'queue' | 'bracket';

/*
 * Players, matches and stations change only through server commands (src/lib/tournament.ts):
 * `run` checks the command against this device's current view first (so an obviously
 * impossible action is explained right away), then queues it with sendCommand. The server has
 * the final say; anything it refuses comes back through usePendingWork as a conflict.
 * Check-ins stay plain field edits (updateStore) — they merge safely.
 *
 * HQ owns the bracket: only HQ (role 'super') can paste one here or reset it; field admins
 * wait for HQ's player list and run the day. Players can also check themselves in by QR
 * (src/lib/checkin.ts) — the server writes those, and they arrive here through normal sync.
 */
interface Cmds {
  run: (cmd: Command) => boolean; // a refusal lands in the notices at the top of the page
  attempt: (cmd: Command) => string | null; // the same, but the refusal comes back to the caller — for the sheets, which cover those notices
  check: (cmd: Command) => string | null; // the precheck alone: why this device's view refuses it, or null
  base: number;
  inFlight: PendingWork[];
  pendingFor: (matchId: string) => PendingWork | undefined;
  pendingStart: (station: number) => PendingWork | undefined;
  offline: boolean;
}

export function DayPage({ storeId }: { storeId: string }) {
  const store = useApp((s) => s.stores[storeId]);
  const { short: storeName } = useStoreName(store);
  const { role, status } = useSync();
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const [tab, setTab] = useState<Tab>(store?.day.matches.length ? 'queue' : 'checkin');
  const work = usePendingWork(storeId).filter((w) => w.kind === 'cmd' && w.cmd);
  const [local, setLocal] = useState<{ id: string; cmd: Command; error: string }[]>([]);
  useNow(30000);

  // "Aarav S. checked in by QR" — compare each new view with the one before.
  const seen = useRef<MatchDay | undefined>(undefined);
  const buzzed = useRef(0);
  const [joined, setJoined] = useState<SelfArrival[]>([]);
  useEffect(() => {
    if (!store) return;
    const fresh = newSelfCheckIns(seen.current, store.day);
    seen.current = store.day;
    if (fresh.length) {
      setJoined((j) => [...j.filter((x) => !fresh.some((f) => f.pid === x.pid)), ...fresh].slice(-4));
      // One buzz for a burst of arrivals (a queue at the door), never one each.
      if (Date.now() - buzzed.current > 2500) success();
      buzzed.current = Date.now();
    }
  }, [store?.day]);
  useEffect(() => {
    if (!joined.length) return;
    const t = setTimeout(() => setJoined((j) => j.slice(1)), 12000);
    return () => clearTimeout(t);
  }, [joined]);

  if (!store || !event) return <NotFound />;

  const day = store.day;
  const hq = role === 'super';
  const editDay = (fn: (d: MatchDay) => void) => updateStore(store.id, (s) => fn(s.day));
  const undoSelf = async (pid: string) => {
    const p = day.players.find((x) => x.id === pid);
    if (!p || !day.checkIn[pid] || !(await askConfirm(`Undo ${p.name}’s QR check-in? They’ll show as not here.`, { ok: 'Undo check-in' }))) return;
    editDay((d) => undoCheckIn(d, pid));
    setJoined((j) => j.filter((x) => x.pid !== pid));
  };
  const names = Object.fromEntries(day.players.map((p) => [p.id, p.name]));
  // Every check-in the admin makes by hand (list, sheet, queue, bracket) goes through here: the edit, a two-pulse buzz and a quiet toast.
  const checkInStaff = (pid: string) => {
    editDay((d) => staffCheckIn(d, pid, new Date().toISOString()));
    success();
    toast(`${publicName(names[pid] ?? 'Player')} checked in`);
  };
  const igns: Record<string, string> = Object.fromEntries(day.players.flatMap((p) => (p.ign ? [[p.id, p.ign]] : [])));
  const here = Object.keys(day.checkIn).length;
  const q = computeQueue(day);
  const left = day.matches.filter((m) => m.status !== 'done').length;

  const check = (cmd: Command) => {
    try {
      precheck(store, event, cmd, role ?? 'admin');
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const attempt = (cmd: Command) => {
    const refused = check(cmd);
    if (refused) return refused;
    try {
      sendCommand(store.id, cmd);
      return null;
    } catch (e) {
      return `Couldn’t queue this on the device: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  const run = (cmd: Command) => {
    const error = attempt(cmd);
    if (error) setLocal((l) => [...l, { id: uid(), cmd, error }]);
    return !error;
  };
  const inFlight = work.filter((w) => w.state === 'queued' || w.state === 'sending');
  const cmds: Cmds = {
    run,
    attempt,
    check,
    base: dayVersion(store),
    inFlight,
    pendingFor: (id) => inFlight.find((w) => w.cmd && 'matchId' in w.cmd && w.cmd.matchId === id),
    pendingStart: (st) => inFlight.find((w) => w.cmd?.type === 'match.start' && w.cmd.station === st),
    offline: status !== 'live',
  };

  // The champion / winner-details card (queue + bracket tabs). hero = the queue's big champion block.
  const winnersPending = inFlight.find((w) => w.cmd?.type === 'winners.set');
  const banner = (hero = false) => (
    <WinnersBanner
      day={day}
      names={names}
      hero={hero}
      offline={cmds.offline}
      pending={winnersPending ? (winnersPending.state === 'sending' ? 'sending' : 'queued') : null}
      save={(winner, runnerUp) => cmds.attempt({ type: 'winners.set', base: cmds.base, winner, runnerUp })}
    />
  );

  return (
    <Shell wide crumbs={storeCrumbs(role, event, store, { label: 'Match day' })}>
      <PageHead kicker={`Match day · ${event.name}`} title={storeName}>
        <div className="day-stats">
          <div>
            <strong>
              {here}
              <small>/{day.players.length}</small>
            </strong>
            <span>Checked in</span>
          </div>
          <div>
            <strong>{q.live.length}</strong>
            <span>Playing now</span>
          </div>
          <div>
            <strong>{q.ready.length}</strong>
            <span>Ready to call</span>
          </div>
          <div>
            <strong>{day.matches.length ? left : '—'}</strong>
            <span>Matches left</span>
          </div>
          <a className="btn ghost" href={`#/store/${store.id}/board`} target="_blank" rel="noreferrer">
            Open venue board ↗
          </a>
        </div>
      </PageHead>

      <div className="tabs" role="tablist">
        {(
          [
            ['checkin', 'Check-in'],
            ['queue', 'Queue'],
            ['bracket', 'Bracket'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={cx(tab === k && 'on')} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      <WorkNotices day={day} work={work} local={local} offline={cmds.offline} onDismissLocal={(id) => setLocal((l) => l.filter((x) => x.id !== id))} />
      <SteamCard store={store} />

      {!day.players.length && hq ? (
        <section className="feed-wait">
          <h2>No players yet.</h2>
          <p className="deck">Add them in this store’s Players & bracket page — import a CSV or sheet (its order is the seed order), then build the bracket.</p>
          <a className="btn accent" href={`#/store/${store.id}/players`}>
            Players & bracket →
          </a>
        </section>
      ) : tab === 'checkin' ? (
        // With no list yet the admin still registers walk-ins here (CheckIn shows the waiting note).
        <CheckIn day={day} editDay={editDay} names={names} cmds={cmds} hq={hq} onUndoSelf={undoSelf} onCheckIn={checkInStaff} />
      ) : !day.players.length ? (
        <section className="feed-wait">
          <h2>Waiting for the players.</h2>
          <p className="deck">HQ hasn’t loaded the players yet — they’ll appear here automatically. Walk-ins can be registered on the Check-in tab meanwhile.</p>
        </section>
      ) : !day.matches.length ? (
        <section className="feed-wait">
          <h2>No bracket yet.</h2>
          {hq ? (
            <>
              <p className="deck">The players are in — build the bracket on the Players & bracket page.</p>
              <a className="btn accent" href={`#/store/${store.id}/players`}>
                Players & bracket →
              </a>
            </>
          ) : (
            <p className="deck">HQ hasn’t built the bracket yet — it appears here automatically. Check-in works already.</p>
          )}
        </section>
      ) : tab === 'queue' ? (
        <QueueView day={day} names={names} igns={igns} cmds={cmds} banner={banner} onCheckIn={checkInStaff} />
      ) : (
        <>
          {banner()}
          <BracketView store={store} names={names} igns={igns} cmds={cmds} canReset={hq} hq={hq} onCheckIn={checkInStaff} />
        </>
      )}

      <JoinedNotices
        list={joined.filter((j) => names[j.pid] && isSelf(day, j.pid) && day.checkIn[j.pid] === j.at)}
        names={names}
        onUndo={undoSelf}
        onDismiss={(pid) => setJoined((j) => j.filter((x) => x.pid !== pid))}
      />
    </Shell>
  );
}

/** Run the real handler over this device's view — throws the same CommandError the server would. */
function precheck(store: Store, event: TournamentEvent, cmd: Command, role: 'super' | 'admin') {
  tournamentCommand(store, cmd, { commandId: 'precheck', now: new Date().toISOString(), actor: { principal: '', name: '', role }, event });
}

/* ---------- queued / refused match actions ---------- */

function describe(cmd: Command, day: MatchDay) {
  const m = 'matchId' in cmd ? day.matches.find((x) => x.id === cmd.matchId) : undefined;
  const L = m ? `M${matchNo(m, day.matches)}` : 'a match';
  switch (cmd.type) {
    case 'match.start':
      return `Call ${L} to station ${cmd.station}`;
    case 'match.finish':
      return cmd.walkover ? `Walkover in ${L}` : `Result for ${L}`;
    case 'match.undo':
      return m?.status === 'live' ? `Cancel ${L}` : `Undo ${L}`;
    case 'bracket.place':
      return `Change the players in ${L}`;
    case 'stations.set':
      return `Set stations to ${cmd.count}`;
    case 'bracket.load':
      return 'Load the bracket';
    case 'bracket.reset':
      return 'Reset the bracket';
    case 'players.onspot':
      return `Register ${cmd.name.trim() || 'a player'} on the spot`;
    case 'winners.set':
      return 'Save the winner details';
    case 'onspot.mark': {
      const e = day.onSpot?.find((x) => x.id === cmd.entryId);
      return `Mark ${e?.name ?? 'an on-the-spot player'} as ${cmd.done ? 'added to' : 'not yet on'} Toornament`;
    }
    default:
      return cmd.type;
  }
}

const pendingLabel = (w: PendingWork, offline: boolean) => (w.state === 'sending' ? 'Sending…' : offline ? 'Queued · offline' : 'Queued');

function WorkNotices({
  day,
  work,
  local,
  offline,
  onDismissLocal,
}: {
  day: MatchDay;
  work: PendingWork[];
  local: { id: string; cmd: Command; error: string }[];
  offline: boolean;
  onDismissLocal: (id: string) => void;
}) {
  const refused = work.filter((w) => w.state === 'conflict' || w.state === 'failed');
  const waiting = work.filter((w) => w.state === 'queued' || w.state === 'sending');
  if (!refused.length && !local.length && !waiting.length) return null;
  const regs = waiting.filter((w) => w.cmd?.type === 'players.onspot').length;
  const saves = waiting.filter((w) => w.cmd?.type === 'winners.set').length;
  const noun = (n: number) =>
    regs === n ? `registration${n === 1 ? '' : 's'}` : saves === n ? `winner-details save${n === 1 ? '' : 's'}` : regs || saves ? `action${n === 1 ? '' : 's'}` : `match action${n === 1 ? '' : 's'}`;
  return (
    <div className="day-notices" role="status">
      {local.map((x) => (
        <div key={x.id} className="day-notice conflict">
          <span>
            <strong>{describe(x.cmd, day)} — not done.</strong> {x.error}
          </span>
          <button className="link" onClick={() => onDismissLocal(x.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {refused.map((w) => (
        <div key={w.id} className={cx('day-notice', w.state)}>
          <span>
            <strong>
              {describe(w.cmd!, day)} — {w.state === 'conflict' ? 'refused by the server' : 'couldn’t be sent'}.
            </strong>{' '}
            {w.error ?? 'No reason given.'} {w.state === 'conflict' && 'The queue now shows the latest state.'}
          </span>
          <span className="row tight">
            {w.state === 'failed' && (
              <button className="link" onClick={() => retryWork(w.id)}>
                Retry
              </button>
            )}
            <button className="link" onClick={() => discardWork(w.id)}>
              Dismiss
            </button>
          </span>
        </div>
      ))}
      {waiting.length > 0 && (
        <div className="day-notice waiting">
          <span>
            {offline
              ? `${waiting.length} ${noun(waiting.length)} saved on this device — offline, not on the server yet. They’ll be checked and sent when the connection is back.`
              : `Sending ${waiting.length} ${noun(waiting.length)}…`}
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------- attendance ---------- */

function CheckIn({
  day,
  editDay,
  names,
  cmds,
  hq,
  onUndoSelf,
  onCheckIn,
}: {
  day: MatchDay;
  editDay: (fn: (d: MatchDay) => void) => void;
  names: Record<string, string>;
  cmds: Cmds;
  hq: boolean;
  onUndoSelf: (pid: string) => void;
  onCheckIn: (pid: string) => void; // by hand: the edit plus buzz and toast
}) {
  const offline = cmds.offline;
  const [filter, setFilter] = useState<'all' | 'out' | 'in'>('all');
  const [search, setSearch] = useState('');
  const onSpot = onSpotByPlayer(day); // same matching as HQ's list: id, then phone, then name
  const list = day.players
    .filter((p) => (filter === 'all' ? true : filter === 'in' ? day.checkIn[p.id] : !day.checkIn[p.id]))
    .filter((p) => matchesPlayer(p, search))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The player whose name was tapped: a sheet with the full number and Call (the list stays masked).
  const [open, setOpen] = useState<string | null>(null);
  const toggle = async (p: Player) => {
    if (day.checkIn[p.id]) {
      if (!(await askConfirm(`Undo check-in for ${p.name}?${isSelf(day, p.id) ? ' They checked in by QR.' : ''}`, { ok: 'Undo check-in' }))) return false;
      editDay((d) => undoCheckIn(d, p.id));
    } else onCheckIn(p.id);
    return true;
  };
  // Rows that flip to "Here" while this list is open get a tick and a flash — by hand, by QR or from another phone alike.
  const justIn = useFreshIds(Object.keys(day.checkIn), 2400);
  const here = day.players.filter((p) => day.checkIn[p.id]).length;

  // Positions stay fixed (falsy placeholders), so the desk form keeps its state when the first walk-in fills an empty list.
  const empty = !day.players.length;
  return (
    <section>
      {empty && (
        <section className="feed-wait">
          <h2>Waiting for the players.</h2>
          <p className="deck">HQ hasn’t loaded the players yet — they’ll appear here automatically. Walk-ins can be registered now: they’re checked in and HQ sees them as on the spot.</p>
        </section>
      )}
      {!empty && <CheckInProgress here={here} total={day.players.length} />}
      <OnSpotDesk day={day} cmds={cmds} hq={hq} startOpen={empty} onCheckIn={onCheckIn} />
      {!empty && <SelfCheckInPanel day={day} editDay={editDay} names={names} offline={offline} onUndo={onUndoSelf} />}
      {!empty && (
        <>
      <div className="toolbar">
        <input className="search" placeholder="Find a player — name, in-game name or phone digits" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="seg small">
          {(
            [
              ['all', 'All'],
              ['out', 'Not here'],
              ['in', 'Here'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={cx(filter === k && 'on')} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <ul className="roster">
        {list.map((p) => (
          <li key={p.id}>
            <div className={cx('roster-row', day.checkIn[p.id] && 'in', justIn.has(p.id) && 'just-in', justIn.has(p.id) && isSelf(day, p.id) && 'by-qr')}>
              <span className="seed">{String(p.seed).padStart(2, '0')}</span>
              <button className="pmain" onClick={() => setOpen(p.id)} aria-haspopup="dialog" title="Name, number and Call">
                <span className="pname">{p.name}</span>
                {(isSelf(day, p.id) || onSpot.has(p.id) || phoneTail(p) || p.ign) && (
                  <span className="pmeta">
                    {onSpot.has(p.id) && (
                      <span className="onspot-tag" title="Registered at the desk on the day">
                        On spot
                      </span>
                    )}
                    {isSelf(day, p.id) && (
                      <span className={cx('self-tag', justIn.has(p.id) && 'fd-pop')} title="Checked in by QR">
                        Self
                      </span>
                    )}
                    {p.ign && (
                      <span className="ign" title="In-game name">
                        {p.ign}
                      </span>
                    )}
                    {maskedPhone(p)}
                  </span>
                )}
              </button>
              <button className={cx('pstate', justIn.has(p.id) && 'fd-pop')} onClick={() => toggle(p)}>
                {day.checkIn[p.id] ? (
                  <>
                    <svg className="cicheck" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 8.5l3.2 3.2L13 4.8" pathLength="1" />
                    </svg>
                    Here · {fmtTime(day.checkIn[p.id])}
                  </>
                ) : (
                  'Check in'
                )}
              </button>
            </div>
          </li>
        ))}
        {!list.length && <li className="empty">No one matches.</li>}
      </ul>
      <PlayerSheet
        player={day.players.find((x) => x.id === open) ?? null}
        day={day}
        hq={hq}
        onSpot={open ? onSpot.get(open) : undefined}
        // An admin checking someone in stays on the sheet: the number arrives with the server's confirmation.
        onToggle={async (p) => {
          const wasIn = !!day.checkIn[p.id];
          if ((await toggle(p)) && (hq || wasIn)) setOpen(null);
        }}
        onClose={() => setOpen(null)}
      />
        </>
      )}
    </section>
  );
}

/** "18 / 32 here" and a bar that fills as people arrive (a transform, not a width, so it stays smooth on a phone). */
function CheckInProgress({ here, total }: { here: number; total: number }) {
  const prev = useRef(here);
  const bumped = prev.current !== here;
  useEffect(() => {
    prev.current = here;
  });
  const done = total > 0 && here >= total;
  // Starts empty and fills on the next frame, so the bar grows into view on opening the tab as well as with each arrival.
  const [fill, setFill] = useState(0);
  useEffect(() => {
    const f = requestAnimationFrame(() => setFill(total ? Math.min(1, here / total) : 0));
    return () => cancelAnimationFrame(f);
  }, [here, total]);
  return (
    <div className={cx('cistrip', done && 'full')} role="group" aria-label="Check-in progress">
      <div className="cistrip-top">
        <strong key={here} className={cx('cistrip-count', bumped && 'fd-pop')}>
          {here} <small>/ {total} here</small>
        </strong>
        <span className="label">{done ? 'Everyone is here' : `${total - here} still to come`}</span>
      </div>
      <div className="cibar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={here} aria-label={`${here} of ${total} checked in`}>
        <i style={{ transform: `scaleX(${fill})` }} />
      </div>
    </div>
  );
}

/* ---------- on-the-spot registration (walk-ins) ---------- */

/**
 * The desk form for walk-ins who aren't on HQ's list. players.onspot adds them (next seed),
 * checks them in and records them, so HQ sees them as on the spot and adds them on Toornament.
 * Same phone as someone on the list → it's them (check them in); same name → the admin says
 * whether it's another person, who is then added as "Name (2)".
 */
function OnSpotDesk({ day, cmds, hq, startOpen, onCheckIn }: { day: MatchDay; cmds: Cmds; hq: boolean; startOpen: boolean; onCheckIn: (pid: string) => void }) {
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [ign, setIgn] = useState('');
  const [problem, setProblem] = useState<{ text: string; pid?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = useRef(false);
  useEffect(() => {
    // Not on first render (no keyboard popping up on page load) — when opened, and after each registration.
    if (open && focusName.current) nameRef.current?.focus();
    focusName.current = false;
  });
  const count = day.onSpot?.length ?? 0;
  const pending = cmds.inFlight.filter((w) => w.cmd?.type === 'players.onspot');
  const stuck = problem?.pid ? day.players.find((p) => p.id === problem.pid) : undefined;

  const reset = () => {
    setName('');
    setPhone('');
    setIgn('');
    focusName.current = true;
  };
  const checkInNow = (p: Player) => {
    onCheckIn(p.id);
    setProblem(null);
    setDone(`${p.name} checked in.`);
    reset();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (asking) return;
    setProblem(null);
    setDone(null);
    const n = name.replace(/\s+/g, ' ').trim();
    const tel = phone.trim();
    if (!n) {
      setProblem({ text: 'Type the player’s name.' });
      nameRef.current?.focus();
      return;
    }
    if (tel && !isPhone(tel)) return setProblem({ text: 'That phone number doesn’t look right — type 8–15 digits, or leave it empty.' });
    const clash = onSpotClash(day, n, tel || undefined);
    if (clash?.kind === 'phone') {
      const p = clash.player;
      return setProblem({ text: `The number ending ${normalizePhone(tel).slice(-4)} is already on the list as ${p.name}${day.checkIn[p.id] ? ' — already checked in.' : '.'}`, pid: p.id });
    }
    let shown = n;
    let sameName: 'different' | undefined;
    if (clash?.kind === 'name') {
      const p = clash.player;
      const alt = differentName(day, n);
      setAsking(true);
      const other = await askConfirm(
        `${p.name} is already on the list${phoneTail(p) ? ` (number ending ${phoneTail(p)})` : ''}${day.checkIn[p.id] ? ' and checked in' : ''}. Is this a different person?`,
        { ok: `Different person → add as “${alt}”` },
      );
      setAsking(false);
      if (!other) return setProblem({ text: `Not registered. If it’s ${p.name}, check them in from the list.`, pid: p.id });
      shown = alt;
      sameName = 'different';
    } else if (clash?.kind === 'phone-end') {
      // Only the last 4 digits of this player are on this device, so it may or may not be them: ask, don't block. The server has every number and refuses a real duplicate.
      const p = clash.player;
      setAsking(true);
      const other = await askConfirm(`${p.name} on the list has a number ending ${p.phoneEnd}${day.checkIn[p.id] ? ' and is checked in' : ''} — the same last digits. Is this a different person?`, { ok: 'Different person → register' });
      setAsking(false);
      if (!other) return setProblem({ text: `Not registered. If it’s ${p.name}, check them in from the list.`, pid: p.id });
    }
    const cmd: Command = { type: 'players.onspot', base: cmds.base, name: n, ...(tel ? { phone: tel } : {}), ...(ign.trim() ? { ign: ign.trim() } : {}), ...(sameName ? { sameName } : {}) };
    const refused = cmds.check(cmd);
    if (refused) return setProblem({ text: refused });
    if (!cmds.run(cmd)) return; // couldn't be queued — the notice at the top says why
    success();
    setDone(`${shown} registered on the spot and checked in${cmds.offline ? ' — saved on this device, it goes to the server when the connection is back' : ''}.`);
    reset();
  };

  // Once the bracket is out only HQ registers walk-ins (it places them); the server refuses the desk too.
  if (!hq && day.matches.length > 0)
    return (
      <div className="onspot-bar">
        <span className="hint">The bracket is out — on-spot registration is closed. Ask HQ if a player must be added.</span>
      </div>
    );

  if (!open)
    return (
      <div className="onspot-bar">
        <button
          className="btn"
          onClick={() => {
            focusName.current = true;
            setOpen(true);
          }}
        >
          Register on the spot
        </button>
        <span className="hint">Walk-in who isn’t on the list? Register them here — they’re checked in and HQ sees them as on the spot{count ? ` · ${count} so far` : ''}.</span>
      </div>
    );

  return (
    <form className="onspot" onSubmit={submit} noValidate aria-labelledby="onspot-h">
      <div className="onspot-head">
        <h2 id="onspot-h">Register on the spot</h2>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="hint">For walk-ins who aren’t on HQ’s list. They join the list checked in; HQ sees them as on the spot and adds them on Toornament{count ? ` · ${count} registered here so far` : ''}.</p>
      <label className="field">
        <span className="label">Name</span>
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" autoCapitalize="words" enterKeyHint="next" placeholder="e.g. Ravi K." />
      </label>
      <div className="grid2">
        <label className="field">
          <span className="label">Phone</span>
          <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={24} autoComplete="off" placeholder="Optional — lets them use the QR" />
        </label>
        <label className="field">
          <span className="label">In-game name</span>
          <input value={ign} onChange={(e) => setIgn(e.target.value)} maxLength={MAX_IGN} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder="Optional" />
        </label>
      </div>
      {problem && (
        <div className="onspot-msg problem" role="alert">
          <span>{problem.text}</span>
          {stuck && !day.checkIn[stuck.id] && (
            <button type="button" className="btn ghost" onClick={() => checkInNow(stuck)}>
              Check in {stuck.name}
            </button>
          )}
        </div>
      )}
      {done && (
        <div className="onspot-msg ok" role="status">
          {done}
        </div>
      )}
      <button className="btn accent onspot-go" type="submit" disabled={asking}>
        Register and check in
      </button>
      {day.matches.length > 0 && <p className="hint warn">The bracket is already made — add them on Toornament too, then put them in a first-round slot from the bracket (tap the match).</p>}
      {pending.length > 0 && (
        <ul className="onspot-pending">
          {pending.map((w) => (
            <li key={w.id}>
              <span>{w.cmd?.type === 'players.onspot' ? w.cmd.name : ''}</span>
              <span className="pending-tag">{pendingLabel(w, cmds.offline)}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/* ---------- player QR check-in ---------- */

function SelfCheckInPanel({
  day,
  editDay,
  names,
  offline,
  onUndo,
}: {
  day: MatchDay;
  editDay: (fn: (d: MatchDay) => void) => void;
  names: Record<string, string>;
  offline: boolean;
  onUndo: (pid: string) => void;
}) {
  const sc = day.selfCheckIn;
  const open = !!sc?.open;
  useLan(); // re-render once the Wi-Fi address is known
  const url = sc ? checkInUrl(shareOrigin(), sc.token) : '';
  const [copied, setCopied] = useState(false);
  const noPhone = withoutPhone(day.players);
  const recent = recentSelfCheckIns(day).filter((r) => names[r.pid]);

  const toggle = () => editDay((d) => (open ? closeSelfCheckIn(d) : openSelfCheckIn(d, new Date().toISOString())));
  const rotate = async () =>
    (await askConfirm('Make a new QR? The current QR and link stop working right away — printed copies and screenshots too. The venue board switches by itself.', { ok: 'New QR', danger: true })) &&
    editDay((d) => rotateSelfCheckIn(d));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify(`Copy this check-in link: ${url}`);
    }
  };

  return (
    <section className="selfci" aria-labelledby="selfci-h">
      <div>
        <h2 id="selfci-h">
          Player QR check-in
          <span className="selfci-state">
            <Chip tone={open ? 'ok' : 'muted'}>{open ? `Open${sc?.openedAt ? ` · since ${fmtTime(sc.openedAt)}` : ''}` : 'Off'}</Chip>
          </span>
        </h2>
        <p className="hint">
          {open
            ? 'Players scan this QR — it’s on the venue board too — type the phone number HQ has for them, and appear here as checked in. Close it when check-in ends.'
            : 'Let players check themselves in: they scan a QR at the venue and type their phone number. Each one shows up here as they arrive.'}
        </p>
        {noPhone > 0 && (
          <p className="hint warn">
            {noPhone === day.players.length
              ? 'HQ sent no phone numbers, so the QR can’t find anyone — check players in by hand.'
              : `${noPhone} of ${day.players.length} player${day.players.length === 1 ? '' : 's'} ha${noPhone === 1 ? 's' : 've'} no phone number from HQ — check ${noPhone === 1 ? 'them' : 'those'} in by hand.`}
          </p>
        )}
        {open && offline && <p className="hint warn">This device is offline — the QR starts working once your change reaches the server.</p>}
        <div className="row selfci-actions">
          <button className={cx('btn', open ? 'ghost' : 'accent')} onClick={toggle}>
            {open ? 'Close QR check-in' : 'Open QR check-in'}
          </button>
          {sc && (
            <button className="link" onClick={rotate}>
              New QR
            </button>
          )}
        </div>
        {open && (
          <div className="selfci-link">
            <span>{url}</span>
            <button className="link" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="selfci-qr">
          <CheckInQr value={url} />
          <span className="label">Scan to check in</span>
        </div>
      )}
      {recent.length > 0 && (
        <div className="selfci-recent">
          <h3 className="label">Recent QR check-ins</h3>
          <ol>
            {recent.map((r) => (
              <li key={r.pid}>
                <span>
                  {names[r.pid]}
                  <time>{fmtTime(r.at)}</time>
                </span>
                <button className="link" onClick={() => onUndo(r.pid)}>
                  Undo
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** Toasts for QR check-ins that just arrived — any tab. */
function JoinedNotices({ list, names, onUndo, onDismiss }: { list: SelfArrival[]; names: Record<string, string>; onUndo: (pid: string) => void; onDismiss: (pid: string) => void }) {
  if (!list.length) return null;
  return (
    <div className="joined" role="status" aria-live="polite">
      {list.map((j) => (
        <div key={j.pid} className="joined-item fd-enter">
          <span>
            <strong>{publicName(names[j.pid])}</strong> checked in by QR · {fmtTime(j.at)}
          </span>
          <span>
            <button className="link" onClick={() => onUndo(j.pid)}>
              Undo
            </button>
            <button className="link" aria-label="Dismiss" onClick={() => onDismiss(j.pid)}>
              ×
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------- the call queue ---------- */

function QueueView({
  day,
  names,
  igns,
  cmds,
  banner,
  onCheckIn,
}: {
  day: MatchDay;
  names: Record<string, string>;
  igns: Record<string, string>;
  cmds: Cmds;
  banner: (hero?: boolean) => React.ReactNode;
  onCheckIn: (pid: string) => void;
}) {
  const q = computeQueue(day);
  const total = roundCount(day.matches);
  const n = (id: string | null) => (id ? names[id] : 'TBD');
  // On the station cards only — where players are called — the in-game name goes under the name.
  const ign = (id: string | null) => (id && igns[id] ? <small className="ign">{igns[id]}</small> : null);
  const label = (m: Match) => `M${matchNo(m, day.matches)} · ${roundName(m.round, total)}`;
  // Score drafts are per attempt (match + start time), so a cancelled or undone match never
  // brings an old score back when it is played again (audit F16).
  const [scores, setScores] = useState<Record<string, string>>({});
  const draftKey = (m: Match) => `${m.id}@${m.startedAt ?? ''}`;
  const dropDraft = (m: Match) =>
    setScores((s) => {
      const rest = { ...s };
      delete rest[draftKey(m)];
      return rest;
    });
  const call = (m: Match, station: number) => {
    tap();
    return cmds.run({ type: 'match.start', base: cmds.base, matchId: m.id, station });
  };
  const win = (m: Match, w: string, opts: { walkover?: boolean; score?: string } = {}) => {
    const score = opts.score?.trim();
    tap();
    if (cmds.run({ type: 'match.finish', base: cmds.base, matchId: m.id, winner: w, ...(score ? { score } : {}), ...(opts.walkover ? { walkover: true } : {}) })) dropDraft(m);
  };
  const cancel = (m: Match) => cmds.run({ type: 'match.undo', base: cmds.base, matchId: m.id }) && dropDraft(m);

  // Station count: typed values settle for a moment before they're sent, so typing "12" doesn't send "1" first.
  const [stDraft, setStDraft] = useState<number | null>(null);
  useEffect(() => {
    if (stDraft === null) return;
    const t = setTimeout(() => {
      if (stDraft !== day.stations) cmds.run({ type: 'stations.set', base: cmds.base, count: stDraft });
      setStDraft(null);
    }, 700);
    return () => clearTimeout(t);
  }, [stDraft]);

  // The final is recorded: the champion block is the winners card (collect their details), then the usual note.
  if (q.champion && finalResult(day.matches))
    return (
      <>
        {banner(true)}
        <p className="deck champion-note">
          {day.matches.filter((m) => !m.bye).length} matches played. The full results are on the Bracket tab — the store report covers the recce only, not match day.
        </p>
      </>
    );
  if (q.champion)
    return (
      <section className="champion">
        <span className="label">Champion</span>
        <h2>{names[q.champion]}</h2>
        <p className="deck">
          {day.matches.filter((m) => !m.bye).length} matches played. The full results are on the Bracket tab — the store report covers the recce only, not match day.
        </p>
      </section>
    );

  // Pair the next ready matches with free stations so the admin sees exactly what to call.
  const suggest = new Map(q.freeStations.map((s, i) => [s, q.ready[i]?.match]));
  // Every live match gets a card, even on a station above the current count or a doubled-up
  // station (older data) — otherwise its result/cancel controls would vanish (audit F14).
  const extra = [...new Set(q.live.map((m) => m.station ?? 0).filter((s) => s < 1 || s > day.stations))];
  const stationList = [...Array.from({ length: day.stations }, (_, i) => i + 1), ...extra.sort((a, b) => a - b)];

  const liveCard = (m: Match, st: number, crowd: number) => {
    const p = cmds.pendingFor(m.id);
    const draft = scores[draftKey(m)] ?? '';
    return (
      <div key={m.id} className={cx('station', 'live', 'fd-enter', (st > day.stations || st < 1 || crowd > 1) && 'odd')}>
        <div className="station-top">
          <span className="label">{st >= 1 ? `Station ${st}` : 'No station'}</span>
          {p ? <span className="label pending-tag">{pendingLabel(p, cmds.offline)}</span> : <span className="label live-dot">Busy · {minutesSince(m.startedAt)} min</span>}
        </div>
        {st > day.stations && <p className="station-warn">Station {st} is beyond the {day.stations} set up. Finish or cancel this match, or raise the station count.</p>}
        {st < 1 && <p className="station-warn">This match is live without a station. Finish or cancel it.</p>}
        {crowd > 1 && <p className="station-warn">{crowd} matches are live on station {st}. Cancel the one that isn’t being played here.</p>}
        <div className="label">{label(m)}</div>
        <div className="versus">
          <button className="btn win" onClick={() => win(m, m.a!, { score: draft })}>
            <span>{n(m.a)}</span>
            {ign(m.a)}
            <small>won</small>
          </button>
          <span className="vs">vs</span>
          <button className="btn win" onClick={() => win(m, m.b!, { score: draft })}>
            <span>{n(m.b)}</span>
            {ign(m.b)}
            <small>won</small>
          </button>
        </div>
        <input className="score" maxLength={40} placeholder="Score (optional), e.g. 2–1" value={draft} onChange={(e) => setScores({ ...scores, [draftKey(m)]: e.target.value })} />
        <button className="link" onClick={() => cancel(m)}>
          Cancel — send back to queue
        </button>
      </div>
    );
  };

  return (
    <div className="queue">
      {banner()}
      <section>
        <div className="qhead">
          <h2>Stations</h2>
          <div className="qhead-ctl">
            <NumberField label="Stations" value={stDraft ?? day.stations} min={1} max={20} onChange={(v) => v !== null && setStDraft(v)} />
          </div>
        </div>
        <div className="stations">
          {stationList.map((st) => {
            const lives = q.live.filter((x) => (x.station ?? 0) === st);
            if (lives.length) return lives.map((m) => liveCard(m, st, lives.length));
            const next = suggest.get(st);
            const p = cmds.pendingStart(st);
            return (
              <div key={st} className={cx('station', 'free', 'fd-enter', !next && 'idle')}>
                <div className="station-top">
                  <span className="label">Station {st}</span>
                  {p ? <span className="label pending-tag">{pendingLabel(p, cmds.offline)}</span> : <span className="label free-dot">Free</span>}
                </div>
                {next ? (
                  <>
                    <div className="label">Next up · {label(next)}</div>
                    <div className="versus quiet">
                      <span>
                        {n(next.a)}
                        {ign(next.a)}
                      </span>
                      <span className="vs">vs</span>
                      <span>
                        {n(next.b)}
                        {ign(next.b)}
                      </span>
                    </div>
                    <button className="btn accent block" onClick={() => call(next, st)}>
                      Call to station {st}
                    </button>
                  </>
                ) : (
                  <p className="empty">Nothing ready — waiting on check-ins or results.</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2>Up next</h2>
        {q.ready.length ? (
          <ol className="qlist">
            {q.ready.map(({ match: m, since }, i) => (
              <li key={m.id}>
                <span className="qn">{String(i + 1).padStart(2, '0')}</span>
                <span className="qmain">
                  <span className="label">{label(m)}</span>
                  <span className="qpair">
                    {n(m.a)} <em>vs</em> {n(m.b)}
                  </span>
                </span>
                <span className="qside">
                  <span className="label">Both here · {minutesSince(since)} min</span>
                  {q.freeStations[0] && (
                    <button className="btn ghost" onClick={() => call(m, q.freeStations[0])}>
                      Call to {q.freeStations[0]}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">No match has both players here yet.</p>
        )}
      </section>

      {q.waiting.length > 0 && (
        <section>
          <h2>Waiting on check-in</h2>
          <ol className="qlist">
            {q.waiting.map(({ match: m, missing }) => {
              const present = [m.a!, m.b!].find((p) => !missing.includes(p));
              const p = cmds.pendingFor(m.id);
              return (
                <li key={m.id}>
                  <span className="qn">—</span>
                  <span className="qmain">
                    <span className="label">{label(m)}</span>
                    <span className="qpair">
                      <span className={cx(missing.includes(m.a!) && 'absent')}>{n(m.a)}</span> <em>vs</em> <span className={cx(missing.includes(m.b!) && 'absent')}>{n(m.b)}</span>
                    </span>
                  </span>
                  <span className="qside">
                    {p && <span className="label pending-tag">{pendingLabel(p, cmds.offline)}</span>}
                    {missing.map((pid) => (
                      <button key={pid} className="btn ghost" onClick={() => onCheckIn(pid)}>
                        Check in {names[pid].split(' ')[0]}
                      </button>
                    ))}
                    {present ? (
                      <button
                        className="link"
                        onClick={async () => (await askConfirm(`${names[missing[0]]} is a no-show? ${names[present]} advances by walkover.`, { ok: 'Walkover' })) && win(m, present, { walkover: true })}
                      >
                        Walkover → {names[present].split(' ')[0]}
                      </button>
                    ) : (
                      // Double no-show has no agreed policy yet (audit §6.4) — no fake walkover here.
                      <span className="label warn">Both players missing</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {q.upcoming.length > 0 && (
        <section>
          <h2>Later</h2>
          <ol className="qlist quiet">
            {q.upcoming.map((m) => {
              const feeder = (side: 0 | 1) => day.matches.find((x) => x.round === m.round - 1 && x.index === m.index * 2 + side)!;
              const who = (id: string | null, side: 0 | 1) => (id ? names[id] : `Winner of M${matchNo(feeder(side), day.matches)}`);
              return (
                <li key={m.id}>
                  <span className="qn">—</span>
                  <span className="qmain">
                    <span className="label">{label(m)}</span>
                    <span className="qpair">
                      {who(m.a, 0)} <em>vs</em> {who(m.b, 1)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

/* ---------- bracket ---------- */

/** The route icon beside a name: tap it to light up that player's whole path. */
const FollowIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="4.5" cy="14.5" r="2" />
    <circle cx="15.5" cy="5.5" r="2" />
    <path d="M6.5 14.5h4a2 2 0 0 0 2-2v-5a2 2 0 0 1 1-1.7" />
  </svg>
);

/** A short sample of a connector line for the key. */
const WireSample = ({ tone }: { tone: WireTone }) => (
  <svg className="bwire-sample" viewBox="0 0 60 14" width="60" height="14" aria-hidden>
    <path className={cx('bwire', tone)} d="M2 7H58" />
  </svg>
);

/** The key above the chart: one entry per state a match card can be in, drawn exactly as on the cards. Collapsible, and remembers it on this device. */
function BracketLegend() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('fd.bracketKey') !== 'closed';
    } catch {
      return true;
    }
  });
  return (
    <details
      className="blegend"
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        setOpen(now);
        try {
          localStorage.setItem('fd.bracketKey', now ? 'open' : 'closed');
        } catch {
          /* private mode — the key just opens again next time */
        }
      }}
    >
      <summary>
        <span className="label">Key — what the cards mean</span>
        <span className="label blegend-tap">Tap a match to act on it</span>
      </summary>
      <ul className="blegend-list">
        {KIND_ORDER.map((k) => (
          <li key={k}>
            <StateTag kind={k} />
            <span>{KIND_INFO[k].hint}</span>
          </li>
        ))}
        <li>
          <span className="bmark here" aria-hidden>
            ✓
          </span>
          <span>Player checked in.</span>
        </li>
        <li>
          <span className="bmark away" aria-hidden>
            ○
          </span>
          <span>Player not here — row shaded.</span>
        </li>
        <li>
          <WireSample tone="ink" />
          <span>Ink line — the winner went this way.</span>
        </li>
        <li>
          <WireSample tone="live" />
          <span>Red line — that match is being played.</span>
        </li>
        <li>
          <WireSample tone="rule" />
          <span>Grey line — still to be played.</span>
        </li>
        <li>
          <span className="bfollow demo" aria-hidden>
            <FollowIcon />
          </span>
          <span>Tap this beside a name to follow that player’s path; tap again to clear.</span>
        </li>
      </ul>
    </details>
  );
}

const SLOT_MARK: Record<SlotKind, string> = { here: '✓', away: '○', won: '', lost: '', adv: '', tbd: '', bye: '', open: '' };
const SLOT_TAG: Partial<Record<SlotKind, string>> = { away: 'Not here', won: 'Won' };

/** A connector between a match and the one its winner plays next, measured from the cards on screen. */
interface Wire {
  key: string;
  from: string; // match ids
  to: string;
  d: string;
  tone: WireTone;
}
const WIRE_RANK: Record<WireTone, number> = { rule: 0, ink: 1, live: 2 };

function BracketView({ store, names, igns, cmds, canReset, hq, onCheckIn }: { store: Store; names: Record<string, string>; igns: Record<string, string>; cmds: Cmds; canReset: boolean; hq: boolean; onCheckIn: (pid: string) => void }) {
  const { matches, checkIn } = store.day;
  const total = roundCount(matches);
  const rounds = Array.from({ length: total }, (_, r) => matches.filter((m) => m.round === r).sort((a, b) => a.index - b.index));
  const [open, setOpen] = useState<string | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [active, setActive] = useState(() => roundInPlay(matches));

  // The round names sit in a strip that stays under the tabs while the page scrolls, and slides sideways with the chart.
  const scroller = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  // Which round is at the left edge: the picker's lit chip. Throttled to a frame; the last round counts once the chart is scrolled to its end.
  const onScroll = () => {
    if (scroller.current && strip.current) strip.current.style.transform = `translateX(${-scroller.current.scrollLeft}px)`;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const sc = scroller.current;
      const cols = chart.current?.querySelectorAll<HTMLElement>('.bround');
      if (!sc || !cols?.length) return;
      if (sc.scrollWidth > sc.clientWidth && sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2) return setActive(cols.length - 1);
      let best = 0;
      cols.forEach((c, i) => {
        if (Math.abs(c.offsetLeft - sc.scrollLeft) < Math.abs(cols[best].offsetLeft - sc.scrollLeft)) best = i;
      });
      setActive(best);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const toRound = (r: number, smooth = true) => {
    const col = chart.current?.querySelectorAll<HTMLElement>('.bround')[r];
    scroller.current?.scrollTo({ left: col?.offsetLeft ?? 0, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
    setActive(r);
  };
  // Opening the tab on a phone: start at the round that is being played, not at round 1.
  useEffect(() => {
    const r = roundInPlay(matches);
    if (r > 0) toRound(r, false);
  }, []);

  // Connector lines: an SVG laid over the chart, drawn from where the cards actually are (card heights vary), redrawn when they move.
  const [wires, setWires] = useState<{ w: number; h: number; list: Wire[] }>({ w: 0, h: 0, list: [] });
  const measure = useCallback(() => {
    const el = chart.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const at = new Map<string, { l: number; r: number; y: number }>();
    el.querySelectorAll<HTMLElement>('[data-mid]').forEach((n) => {
      const b = n.getBoundingClientRect();
      at.set(n.dataset.mid!, { l: b.left - box.left, r: b.right - box.left, y: b.top - box.top + b.height / 2 });
    });
    const list: Wire[] = [];
    for (const m of matches) {
      const to = at.get(m.id);
      if (!to) continue;
      for (const side of [0, 1] as const) {
        const f = feederOf(m, side, matches);
        const from = f && at.get(f.id);
        if (!f || !from) continue;
        const mid = Math.round(from.r + (to.l - from.r) / 2);
        list.push({ key: `${f.id}>${m.id}`, from: f.id, to: m.id, d: `M${Math.round(from.r)} ${Math.round(from.y)}H${mid}V${Math.round(to.y)}H${Math.round(to.l)}`, tone: wireTone(f) });
      }
    }
    const w = Math.round(box.width);
    const h = Math.round(box.height);
    setWires((prev) => (prev.w === w && prev.h === h && prev.list.length === list.length && prev.list.every((x, i) => x.d === list[i].d && x.tone === list[i].tone) ? prev : { w, h, list }));
  }, [matches]);
  useLayoutEffect(measure, [measure, cmds.inFlight.length]);
  useEffect(() => {
    const el = chart.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [measure]);

  // Following a player: their matches stay lit, everything else steps back.
  const followed = follow && matches.some((m) => m.a === follow || m.b === follow) ? follow : null;
  const onPath = followed ? pathOf(matches, followed) : new Set<string>();
  const mine = followed ? matches.filter((m) => m.a === followed || m.b === followed).sort((x, y) => x.round - y.round) : [];
  const nextOfMine = mine.find((m) => m.status !== 'done');
  const lastOfMine = mine[mine.length - 1];

  // A match that just finished pops once; one that was just called gets a ring. Neither on first render.
  const popped = useFreshIds(matches.filter((m) => m.status === 'done' && !m.bye).map((m) => m.id), 1200);
  const called = useFreshIds(matches.filter((m) => m.status === 'live').map((m) => m.id), 1800);

  const reset = async () => {
    if (!(await askConfirm('Reset the bracket? Every result and live match is cleared. Players (in their order) and check-ins stay — build it again on the Players & bracket page.', { ok: 'Reset bracket', danger: true }))) return;
    cmds.run({ type: 'bracket.reset', base: cmds.base });
  };

  const no = (m: Match) => `M${matchNo(m, matches)}`;
  const slot = (m: Match, side: 0 | 1) => {
    const id = side === 0 ? m.a : m.b;
    const kind = slotKind(m, id, checkIn);
    const f = feederOf(m, side, matches);
    const text = id ? names[id] : kind === 'bye' ? 'Bye' : f ? `Winner of ${no(f)}` : kind === 'open' ? '—' : 'TBD';
    const tag = SLOT_TAG[kind];
    const lit = !!id && id === followed;
    return (
      <span className={cx('bslot', kind, lit && 'mine')} title={id && igns[id] ? `In-game name: ${igns[id]}` : undefined}>
        <span className="bmark" aria-hidden>
          {SLOT_MARK[kind]}
        </span>
        <span className="bname" aria-hidden>
          {text}
        </span>
        {tag && (
          <span className="btag" aria-hidden>
            {tag}
          </span>
        )}
        {id && (
          <button
            type="button"
            className={cx('bfollow', lit && 'on')}
            aria-pressed={lit}
            aria-label={lit ? `Stop following ${names[id]}` : `Follow ${names[id]}’s path`}
            title={lit ? 'Stop following' : 'Follow this player’s path'}
            onClick={() => {
              tap();
              setFollow(lit ? null : id);
            }}
          >
            <FollowIcon />
          </button>
        )}
      </span>
    );
  };
  const summary = (m: Match, kind: MatchKind) => {
    const who = (id: string | null) => (id ? names[id] : 'to be decided');
    const away = [m.a, m.b].filter((id): id is string => !!id && !checkIn[id]).map((id) => names[id]);
    const state =
      kind === 'one-missing' || kind === 'both-missing' ? `${KIND_INFO[kind].label}: ${away.join(' and ')} not here` : kind === 'live' ? `live on station ${m.station}` : kind === 'done' ? `done, ${names[m.winner ?? ''] ?? 'no winner'} won` : KIND_INFO[kind].label.toLowerCase();
    return `${no(m)}, ${who(m.a)} versus ${who(m.b)} — ${state}. Open`;
  };
  const isOn = (w: Wire) => onPath.has(w.from) && onPath.has(w.to);
  const wireList = [...wires.list].sort((x, y) => Number(isOn(x)) - Number(isOn(y)) || WIRE_RANK[x.tone] - WIRE_RANK[y.tone]);

  return (
    <section>
      <BracketLegend />
      <div className="bnav">
        <div className="bpick" role="group" aria-label="Jump to a round">
          {rounds.map((list, r) => {
            const live = list.some((m) => m.status === 'live');
            const done = list.every((m) => m.status === 'done');
            return (
              <button key={r} type="button" className={cx('bchip', active === r && 'on', live && 'live', done && 'done')} aria-current={active === r ? 'true' : undefined} title={`Go to ${roundName(r, total)}`} onClick={() => (tap(), toRound(r))}>
                {live && <i className="bdot fd-pulse" aria-hidden />}
                {done && <span aria-hidden>✓</span>}
                {roundShort(r, total)}
                {(live || done) && <span className="sr-only">{live ? ', a match is live' : ', all done'}</span>}
              </button>
            );
          })}
        </div>
        {followed && (
          <div className="bfollowbar fd-enter" role="status">
            <span>
              Following <strong>{names[followed]}</strong>
              <span className="label">
                {nextOfMine
                  ? ` · next ${no(nextOfMine)}, ${roundName(nextOfMine.round, total)}`
                  : lastOfMine?.winner === followed
                    ? ' · champion'
                    : lastOfMine
                      ? ` · out in ${roundName(lastOfMine.round, total)}`
                      : ''}
              </span>
            </span>
            <span className="row tight">
              {nextOfMine && (
                <button type="button" className="link" onClick={() => toRound(nextOfMine.round)}>
                  Go there
                </button>
              )}
              <button type="button" className="link" onClick={() => setFollow(null)}>
                Clear
              </button>
            </span>
          </div>
        )}
        <div className="bhead" aria-hidden>
          <div ref={strip} className="bracket" style={{ ['--rounds' as string]: total }}>
            {rounds.map((list, r) => (
              <div key={r} className="bround-head">
                <span className="label">{roundName(r, total)}</span>
                <span className="label">{list.every((m) => m.status === 'done') ? 'all done' : `${list.filter((m) => m.status === 'done').length}/${list.length} done`}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={cx('bracket-scroll', followed && 'following')} ref={scroller} onScroll={onScroll}>
        <div className="bracket" ref={chart} style={{ ['--rounds' as string]: total }}>
          <svg className="bwires" width={wires.w} height={wires.h} aria-hidden>
            {wireList.map((w) => (
              <path key={w.key} d={w.d} className={cx('bwire', w.tone, followed && (isOn(w) ? 'on' : 'dim'))} />
            ))}
          </svg>
          {rounds.map((list, r) => (
            <div key={r} className="bround">
              <div className="bround-list">
                {list.map((m) => {
                  const st = matchState(m, store.day);
                  const p = cmds.pendingFor(m.id);
                  return (
                    <div key={m.id} data-mid={m.id} className={cx('bmatch', st.kind, open === m.id && 'open', onPath.has(m.id) && 'onpath', popped.has(m.id) && 'fd-pop', called.has(m.id) && 'just-live')}>
                      {/* A bye has nothing to act on for the desk (HQ can fill its empty slot); every other card opens its sheet. The button covers the card; the follow buttons sit above it. */}
                      {(st.kind !== 'bye' || hq) && <button type="button" className="bmatch-hit" aria-haspopup="dialog" aria-label={summary(m, st.kind)} onClick={() => setOpen(m.id)} />}
                      <span className="bmatch-top" aria-hidden>
                        <span className="bno">{no(m)}</span>
                        {m.score && <span className="bscore">{m.score}</span>}
                        {m.walkover && <span className="bwo">W/O</span>}
                        <StateTag kind={st.kind} station={m.station} />
                      </span>
                      {slot(m, 0)}
                      {slot(m, 1)}
                      {p && <span className="bmatch-foot pending-tag">{pendingLabel(p, cmds.offline)}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="submit-bar">
        <span className="label">Swipe sideways for later rounds, or jump with the round buttons</span>
        {canReset ? (
          <span className="row tight">
            <a className="link" href={`#/store/${store.id}/players`}>
              Players & bracket
            </a>
            <button className="btn danger" onClick={reset}>
              Reset bracket
            </button>
          </span>
        ) : (
          <span className="label">HQ owns the bracket — ask HQ to change players</span>
        )}
      </div>
      <MatchSheet matchId={open} day={store.day} names={names} igns={igns} hq={hq} cmds={cmds} pendingText={(w) => pendingLabel(w, cmds.offline)} onCheckIn={onCheckIn} onClose={() => setOpen(null)} />
    </section>
  );
}
