import { Fragment, useState } from 'react';
import { canUndo, matchNo, roundCount, roundName } from '../lib/bracket.ts';
import type { Command } from '../lib/commands.ts';
import { onSpotByPlayer } from '../lib/onspot.ts';
import { feederOf, KIND_INFO, matchState, playedFor, stationSlots, telFor, undoBlockedBy, type MatchKind } from '../lib/day-ui.ts';
import type { PendingWork } from '../lib/db.ts';
import type { Match, MatchDay } from '../lib/types.ts';
import { cx, fmtTime, minutesSince } from '../lib/util.ts';
import { success, tap } from '../lib/haptics.ts';
import { askConfirm, Check } from './ui.tsx';
import { Sheet } from './Sheet.tsx';

/** What the sheet needs from the match-day page's command runner. */
export interface MatchCmds {
  attempt: (cmd: Command) => string | null; // null = queued; else why this device's view refuses it
  base: number;
  pendingFor: (matchId: string) => PendingWork | undefined;
  pendingStart: (station: number) => PendingWork | undefined;
}

/** The little shape + word that says what state a match is in — on bracket cards, in the legend and in the sheet. */
export function StateTag({ kind, station }: { kind: MatchKind; station?: number }) {
  const i = KIND_INFO[kind];
  return (
    <span className={cx('bstate', kind)}>
      {/* the live dot breathes (fd-pulse); every other state keeps its shape */}
      <i aria-hidden className={cx(kind === 'live' && 'bdot fd-pulse')}>
        {kind === 'live' ? '' : i.glyph}
      </i>
      {kind === 'live' && station ? `Live · Stn ${station}` : i.label}
    </span>
  );
}

interface Props {
  matchId: string | null; // open when set
  day: MatchDay;
  names: Record<string, string>;
  igns: Record<string, string>;
  hq: boolean; // HQ can call anyone; a field admin only players who are checked in
  cmds: MatchCmds;
  pendingText: (w: PendingWork) => string;
  onCheckIn: (pid: string) => void;
  onClose: () => void;
}

/**
 * Tap a match in the bracket: what can be done with it right now. Everything goes through the
 * page's command runner, so the same checks and server rules apply as in the Queue tab and a
 * refusal is shown here, in words, instead of being lost behind the sheet.
 */
export function MatchSheet(p: Props) {
  const m = p.matchId ? p.day.matches.find((x) => x.id === p.matchId) : undefined;
  return (
    <Sheet open={!!m} onClose={p.onClose} label={m ? `Match M${matchNo(m, p.day.matches)}` : 'Match'}>
      {/* a new attempt at the same match (cancelled and called again, or a result undone) starts with clean drafts */}
      {m && <MatchBody key={`${m.id}@${m.status}@${m.startedAt ?? ''}`} m={m} {...p} />}
    </Sheet>
  );
}

function MatchBody({ m, day, names, igns, hq, cmds, pendingText, onCheckIn, onClose }: Props & { m: Match }) {
  const all = day.matches;
  const st = matchState(m, day);
  const no = (x: Match) => `M${matchNo(x, all)}`;
  const pend = cmds.pendingFor(m.id);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [walkover, setWalkover] = useState(false);
  const [score, setScore] = useState('');

  // Run a command: close on success; if this device's view refuses it, say why right here.
  const act = (cmd: Command) => {
    const refused = cmds.attempt(cmd);
    if (refused) setError(refused);
    else onClose();
    return !refused;
  };
  const call = (station: number) => act({ type: 'match.start', base: cmds.base, matchId: m.id, station }) && tap();
  const finish = (winner: string, opts: { walkover?: boolean; score?: string } = {}) => {
    const s = opts.score?.trim();
    if (act({ type: 'match.finish', base: cmds.base, matchId: m.id, winner, ...(s ? { score: s } : {}), ...(opts.walkover ? { walkover: true } : {}) })) success();
  };
  const undo = async () => {
    const live = m.status === 'live';
    if (await askConfirm(live ? `Cancel ${no(m)} and send it back to the queue?` : `Undo the result of ${no(m)}? The score is cleared too.`, { ok: live ? 'Cancel match' : 'Undo result', danger: true })) act({ type: 'match.undo', base: cmds.base, matchId: m.id });
  };
  const walkoverTo = async (winner: string, absent: string) => {
    if (await askConfirm(`${names[absent]} is a no-show? ${names[winner]} advances by walkover.`, { ok: 'Walkover' })) finish(winner, { walkover: true });
  };

  const total = roundCount(all);
  const player = (id: string | null, side: 0 | 1) => {
    if (id) {
      const done = m.status === 'done';
      const here = !!day.checkIn[id];
      return (
        <div className={cx('sheet-player', done && m.winner === id && 'won', done && m.winner !== id && 'lost', !done && !here && 'away')}>
          <strong>{names[id]}</strong>
          {igns[id] && <small className="ign">{igns[id]}</small>}
          <span className="label">
            {done ? (m.winner === id ? '■ Won' : 'Lost') : here ? `✓ Here · ${fmtTime(day.checkIn[id])}` : '○ Not here'}
          </span>
        </div>
      );
    }
    const f = feederOf(m, side, all);
    return (
      <div className="sheet-player tbd">
        <strong>{m.bye ? 'Bye' : f ? `Winner of ${no(f)}` : 'To be decided'}</strong>
        <span className="label">{f && f.status === 'live' ? `${no(f)} is live` : f ? `${no(f)} not finished` : ' '}</span>
      </div>
    );
  };

  // HQ, a first-round match that hasn't been played (pending, or a bye): who sits in each slot.
  const canPlace = hq && m.round === 0 && (m.status === 'pending' || !!m.bye);
  const place = (side: 'a' | 'b', playerId: string | null) => {
    const refused = cmds.attempt({ type: 'bracket.place', base: cmds.base, matchId: m.id, side, playerId });
    setError(refused ?? '');
    if (!refused) tap();
  };
  const walkIns = onSpotByPlayer(day);
  const inBracket = new Set(all.flatMap((x) => [x.a, x.b]));
  const placeSide = (side: 'a' | 'b', label: string) => {
    const here = m[side];
    const options = day.players.filter((x) => x.id === here || !inBracket.has(x.id)).sort((x, y) => x.name.localeCompare(y.name));
    return (
      <label className="sheet-place-side">
        <span className="label">{label}</span>
        <select value={here ?? ''} onChange={(e) => place(side, e.target.value || null)}>
          <option value="">Empty slot</option>
          {options.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {walkIns.has(x.id) ? ' (on-spot)' : ''}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const playerOf = (id: string) => day.players.find((x) => x.id === id);
  const free = stationSlots(day);
  const anyFree = free.some((s) => !s.live && !cmds.pendingStart(s.station));
  const firstFree = free.find((s) => !s.live && !cmds.pendingStart(s.station))?.station;

  return (
    <>
      <div className="label">
        {no(m)} · {roundName(m.round, total)}
      </div>
      <div className="sheet-state">
        <StateTag kind={st.kind} station={m.station} />
        {m.status === 'live' && <span className="label">{minutesSince(m.startedAt)} min in</span>}
        {m.status === 'done' && m.walkover && <span className="label">Walkover</span>}
      </div>
      {/* a live match shows the two names as the winner buttons below instead */}
      {st.kind !== 'live' && (
        <div className="sheet-versus">
          {player(m.a, 0)}
          <span className="vs">vs</span>
          {player(m.b, 1)}
        </div>
      )}

      {pend && (
        <p className="sheet-note" role="status">
          <strong className="pending-tag">{pendingText(pend)}</strong> — your last action on this match hasn’t reached the server yet. Wait for it before doing anything else here.
        </p>
      )}
      {error && (
        <p className="sheet-error" role="alert">
          {error}
        </p>
      )}

      <fieldset className="sheet-actions" disabled={!!pend}>
        {st.kind === 'ready' && (
          <>
            <div className="label">Call to station</div>
            <div className="sheet-stations">
              {free.map(({ station, live }) => {
                const queued = cmds.pendingStart(station);
                const open = !live && !queued;
                return (
                  <button key={station} className={cx('btn', station === firstFree ? 'accent' : 'ghost')} disabled={!open} onClick={() => call(station)}>
                    <span>Station {station}</span>
                    {!open && <small>{live ? `${no(live)} live` : 'queued'}</small>}
                  </button>
                );
              })}
            </div>
            {!anyFree && <p className="hint warn">Every station is busy. Finish or cancel a live match first, or raise the station count on the Queue tab.</p>}
          </>
        )}

        {st.kind === 'busy' && st.busyWith && (
          <p className="sheet-why">
            Both players are here, but one of them is still playing {no(st.busyWith)} on station {st.busyWith.station}. Call this match once that one is finished.
          </p>
        )}

        {(st.kind === 'one-missing' || st.kind === 'both-missing') && (
          <>
            <p className="sheet-why">
              {st.kind === 'both-missing' ? 'Neither player has checked in yet.' : `${names[st.missing[0]]} hasn’t checked in yet.`} The match can be called once {st.missing.length === 2 ? 'both are' : 'they are'} here.
            </p>
            {st.missing.map((id) => {
              const p = playerOf(id);
              const tel = p ? telFor(p, !!day.checkIn[id], hq) : null; // missing players aren't checked in, so only HQ gets a link
              return (
                <div key={id} className="sheet-missing">
                  <button className="btn accent" onClick={() => onCheckIn(id)}>
                    Check in {names[id].split(' ')[0]}
                  </button>
                  {tel && (
                    <a className="btn ghost" href={tel}>
                      Call {names[id].split(' ')[0]}
                    </a>
                  )}
                </div>
              );
            })}
            {!hq && st.missing.some((id) => playerOf(id)?.phone || playerOf(id)?.phoneEnd) && <p className="hint">Check them in to see {st.missing.length === 2 ? 'their numbers' : 'their number'}.</p>}
            {st.kind === 'one-missing' ? (
              (() => {
                const here = m.a === st.missing[0] ? m.b! : m.a!;
                return (
                  <button className="link" onClick={() => walkoverTo(here, st.missing[0])}>
                    No-show? Walkover → {names[here].split(' ')[0]}
                  </button>
                );
              })()
            ) : (
              <p className="hint">Both missing has no agreed walkover rule — check one of them in, or wait.</p>
            )}
          </>
        )}

        {st.kind === 'waiting' && (
          <>
            <p className="sheet-why">This match can’t start yet. It needs:</p>
            <ul className="sheet-feeders">
              {([0, 1] as const)
                .filter((side) => !(side === 0 ? m.a : m.b))
                .map((side) => {
                  const f = feederOf(m, side, all);
                  return (
                    <li key={side}>
                      {f ? (
                        <>
                          <strong>{no(f)}</strong> to finish — {f.a ? names[f.a] : 'TBD'} vs {f.b ? names[f.b] : 'TBD'}
                          <span className="label">{f.status === 'live' ? `Live on station ${f.station}` : f.a && f.b ? 'Not started' : 'Waiting on an earlier match too'}</span>
                        </>
                      ) : (
                        'An opponent — none is set for this slot.'
                      )}
                    </li>
                  );
                })}
            </ul>
          </>
        )}

        {st.kind === 'live' && (
          <>
            <div className="label">Who won?</div>
            <div className="versus sheet-winners">
              {[m.a!, m.b!].map((id, i) => (
                <Fragment key={id}>
                  {i === 1 && <span className="vs">vs</span>}
                  <button className={cx('btn', 'win', pick === id && 'picked')} aria-pressed={pick === id} onClick={() => (tap(), setPick(id), setError(''))}>
                    <span>{names[id]}</span>
                    {igns[id] && <small className="ign">{igns[id]}</small>}
                    <small>{pick === id ? '✓ won' : 'tap if won'}</small>
                  </button>
                </Fragment>
              ))}
            </div>
            <Check checked={walkover} onChange={setWalkover} hint="The other player didn’t play — no score is kept.">
              Walkover
            </Check>
            {!walkover && <input className="score" maxLength={40} placeholder="Score (optional), e.g. 2–1" value={score} onChange={(e) => setScore(e.target.value)} />}
            <button className="btn accent block sheet-go" disabled={!pick} onClick={() => pick && finish(pick, { walkover, score: walkover ? '' : score })}>
              {pick ? `Record: ${names[pick]} won${walkover ? ' by walkover' : ''}` : 'Pick the winner'}
            </button>
            <button className="link" onClick={undo}>
              Cancel match — send back to the queue
            </button>
          </>
        )}

        {st.kind === 'done' && (
          <>
            <dl className="sheet-result">
              <div>
                <dt>Winner</dt>
                <dd>{m.winner ? names[m.winner] : '—'}</dd>
              </div>
              {m.score && (
                <div>
                  <dt>Score</dt>
                  <dd>{m.score}</dd>
                </div>
              )}
              {m.station && (
                <div>
                  <dt>Station</dt>
                  <dd>{m.station}</dd>
                </div>
              )}
              {m.endedAt && (
                <div>
                  <dt>Finished</dt>
                  <dd>{fmtTime(m.endedAt)}</dd>
                </div>
              )}
              {playedFor(m) && (
                <div>
                  <dt>Played for</dt>
                  <dd>{playedFor(m)}</dd>
                </div>
              )}
            </dl>
            {canUndo(m, all) ? (
              <button className="btn danger" onClick={undo}>
                Undo result
              </button>
            ) : (
              (() => {
                const n = undoBlockedBy(m, all);
                return n ? (
                  <p className="hint">
                    Can’t undo yet — {no(n)} ({n.a ? names[n.a] : 'TBD'} vs {n.b ? names[n.b] : 'TBD'}) has already {n.status === 'live' ? 'started' : 'been played'}. Undo that one first.
                  </p>
                ) : null;
              })()
            )}
          </>
        )}

        {st.kind === 'bye' && <p className="sheet-why">{(m.a ?? m.b) ? `${names[(m.a ?? m.b)!]} has no opponent in this round and goes straight through.` : 'Nobody is in this slot.'}{hq ? '' : ' Nothing to do here.'}</p>}

        {canPlace && (
          <div className="sheet-place">
            <div className="label">Change players</div>
            <div className="sheet-place-sides">
              {placeSide('a', 'Top')}
              {placeSide('b', 'Bottom')}
            </div>
            <p className="hint">Only first-round matches that haven’t been played can be changed. Change it on Toornament too.</p>
          </div>
        )}
      </fieldset>

      <button className="btn ghost block sheet-close" onClick={onClose}>
        Close
      </button>
    </>
  );
}
