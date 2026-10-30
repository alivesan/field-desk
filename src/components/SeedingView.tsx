import { useState } from 'react';
import { matchNo } from '../lib/bracket.ts';
import type { Command } from '../lib/commands.ts';
import { onSpotByPlayer } from '../lib/onspot.ts';
import type { Match, MatchDay, Player } from '../lib/types.ts';
import { cx } from '../lib/util.ts';
import { tap } from '../lib/haptics.ts';
import { Sheet } from './Sheet.tsx';
import type { MatchCmds } from './MatchSheet.tsx';
import '../styles/seeding.css';

type Side = 'a' | 'b';
/** What the picker is for: one slot (choose who goes in it), or one player (choose where they go). */
type Pick = { slot: { matchId: string; side: Side } } | { player: string } | null;

interface Slot {
  m: Match;
  side: Side;
  id: string | null;
  where: string; // "M3 · top slot"
  open: boolean; // can still change: a first-round match that hasn't been played, or a bye
}

const sideName = (s: Side) => (s === 'a' ? 'top' : 'bottom');

/** Every first-round slot in bracket order. */
function slotsOf(day: MatchDay): Slot[] {
  return day.matches
    .filter((m) => m.round === 0)
    .sort((x, y) => x.index - y.index)
    .flatMap((m) => (['a', 'b'] as const).map((side) => ({ m, side, id: m[side], where: `M${matchNo(m, day.matches)} · ${sideName(side)} slot`, open: m.status === 'pending' || !!m.bye })));
}

const Pencil = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.5 2.5l3 3L5.5 13.5l-3.5.5.5-3.5z" />
  </svg>
);
const Lock = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="7" width="10" height="7" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </svg>
);

/** Name, in-game name, seed, walk-in tag and whether they're here — the same on every row. */
function Who({ p, here, walk }: { p: Player; here: boolean; walk: boolean }) {
  return (
    <span className="seeding-who">
      <span className="seeding-name">
        <strong>{p.name}</strong>
        {p.ign && <small className="ign">{p.ign}</small>}
      </span>
      <span className="seeding-meta">
        <span>(#{p.seed})</span>
        {walk && <span className="seeding-walk">(on-spot)</span>}
        <span className={cx('seeding-here', here && 'in')}>{here ? '✓ Here' : '○ Not here'}</span>
      </span>
    </span>
  );
}

/**
 * HQ's Seeding tab: every first-round slot and who is in it, with the players who have none. A slot
 * whose match hasn't been played can be changed — through the same bracket.place command as the
 * match sheet, so the same checks apply and a refusal is shown in the picker.
 */
export function SeedingView({ day, cmds }: { day: MatchDay; cmds: MatchCmds }) {
  const [pick, setPick] = useState<Pick>(null);
  const walkIns = onSpotByPlayer(day);
  const byId = new Map(day.players.map((p) => [p.id, p]));
  const slots = slotsOf(day);
  const seated = new Set(day.matches.flatMap((x) => [x.a, x.b]));
  const waiting = day.players.filter((p) => !seated.has(p.id)).sort((x, y) => Number(walkIns.has(y.id)) - Number(walkIns.has(x.id)) || x.name.localeCompare(y.name));
  const matches = slots.filter((s) => s.side === 'a').map((s) => s.m);
  const anyOpen = slots.some((s) => s.open);
  const who = (id: string) => {
    const p = byId.get(id);
    return p ? <Who p={p} here={!!day.checkIn[id]} walk={walkIns.has(id)} /> : <strong>Unknown player</strong>;
  };

  return (
    <section className="seeding">
      <p className="deck">First-round slots. Change any slot whose match hasn’t been played — the bracket updates for everyone. Make the same change on Toornament.</p>
      <ol className="seeding-list">
        {matches.map((m) => (
          <li key={m.id} className="seeding-match">
            <span className="seeding-no">
              M{matchNo(m, day.matches)}
              {m.bye && <small>Bye</small>}
            </span>
            <div className="seeding-slots">
              {slots
                .filter((s) => s.m.id === m.id)
                .map((s) =>
                  s.id ? (
                    <div key={s.side} className={cx('seeding-slot', !s.open && 'locked')}>
                      {who(s.id)}
                      {s.open ? (
                        <button type="button" className="seeding-edit" aria-haspopup="dialog" aria-label={`Change ${s.where}`} onClick={() => setPick({ slot: { matchId: m.id, side: s.side } })}>
                          <Pencil />
                        </button>
                      ) : (
                        <span className="seeding-lock">
                          <Lock />
                          {m.status === 'live' ? 'Playing' : 'Played'}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div key={s.side} className="seeding-slot free">
                      <button type="button" className="seeding-add" aria-haspopup="dialog" aria-label={`${s.where} is free — place a player`} onClick={() => setPick({ slot: { matchId: m.id, side: s.side } })}>
                        + Free slot
                      </button>
                    </div>
                  ),
                )}
            </div>
          </li>
        ))}
      </ol>

      <h2 className="seeding-h">Not in the bracket</h2>
      {waiting.length ? (
        <ul className="seeding-waiting">
          {waiting.map((p) => (
            <li key={p.id} className="seeding-slot">
              {who(p.id)}
              <button type="button" className="btn ghost seeding-place" aria-haspopup="dialog" disabled={!anyOpen} onClick={() => setPick({ player: p.id })}>
                Place…
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Everyone on the list has a slot.</p>
      )}
      {waiting.length > 0 && !anyOpen && <p className="hint">Every first-round match has been played, so no slot can be changed.</p>}

      <Sheet open={!!pick} onClose={() => setPick(null)} label="Change a first-round slot">
        {pick && <Picker key={'slot' in pick ? `${pick.slot.matchId}${pick.slot.side}` : pick.player} pick={pick} day={day} slots={slots} waiting={waiting} who={who} cmds={cmds} onClose={() => setPick(null)} />}
      </Sheet>
    </section>
  );
}

interface PickerProps {
  pick: NonNullable<Pick>;
  day: MatchDay;
  slots: Slot[];
  waiting: Player[];
  who: (id: string) => JSX.Element;
  cmds: MatchCmds;
  onClose: () => void;
}

/** The sheet behind the pencil, "+ Free slot" and "Place…": a slot → who goes in it; a player → which slot. */
function Picker({ pick, day, slots, waiting, who, cmds, onClose }: PickerProps) {
  const [error, setError] = useState('');
  // Run bracket.place: close on success; if this device's view refuses it, say why right here.
  const act = (s: Slot, playerId: string | null, swap = false) => {
    const cmd: Command = { type: 'bracket.place', base: cmds.base, matchId: s.m.id, side: s.side, playerId, ...(swap ? { swap: true } : {}) };
    const refused = cmds.attempt(cmd);
    if (refused) setError(refused);
    else {
      tap();
      onClose();
    }
  };
  const closeBtn = (
    <button type="button" className="btn ghost block sheet-close" onClick={onClose}>
      Cancel
    </button>
  );
  const err = error && (
    <p className="sheet-error" role="alert">
      {error}
    </p>
  );

  if ('slot' in pick) {
    const t = slots.find((s) => s.m.id === pick.slot.matchId && s.side === pick.slot.side);
    if (!t || !t.open)
      return (
        <>
          <p className="sheet-why">{t ? `${t.where} can’t be changed any more — its match has been played.` : 'That match is no longer in this bracket.'}</p>
          {closeBtn}
        </>
      );
    // Into a free slot, the player’s old slot is left behind: its match must still have someone in it.
    const others = slots.filter((s) => s.open && s.id && s.id !== t.id && (t.id || s.m[s.side === 'a' ? 'b' : 'a']));
    const canEmpty = !!t.id && !!t.m[t.side === 'a' ? 'b' : 'a'];
    return (
      <>
        <div className="label">{t.where}</div>
        {t.id ? (
          <div className="seeding-now">
            <span className="label">In this slot now</span>
            {who(t.id)}
          </div>
        ) : (
          <p className="sheet-why">This slot is free.</p>
        )}
        {err}
        <div className="seeding-pick">
          <div className="label">Players not in the bracket</div>
          {waiting.length ? (
            <ul>
              {waiting.map((p) => (
                <li key={p.id}>
                  <button type="button" className="seeding-opt" onClick={() => act(t, p.id)}>
                    {who(p.id)}
                    <span className="seeding-go">{t.id ? 'Replace' : 'Place here'}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Everyone already has a slot.</p>
          )}
          <div className="label">Move a player from another slot</div>
          {others.length ? (
            <ul>
              {others.map((s) => (
                <li key={s.m.id + s.side}>
                  <button type="button" className="seeding-opt" onClick={() => act(t, s.id, true)}>
                    {who(s.id!)}
                    <span className="seeding-go">
                      from {s.where.replace(' slot', '')}
                      <small>{t.id ? 'swaps places' : 'that match gets a bye'}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No other slot can be changed.</p>
          )}
          {canEmpty && (
            <button type="button" className="btn ghost block" onClick={() => act(t, null)}>
              Empty this slot
            </button>
          )}
        </div>
        {closeBtn}
      </>
    );
  }

  const p = waiting.find((x) => x.id === pick.player);
  if (!p)
    return (
      <>
        <p className="sheet-why">That player already has a slot.</p>
        {closeBtn}
      </>
    );
  // Free slots first, then the filled ones (whoever is there goes back to the players without a slot).
  const open = slots.filter((s) => s.open);
  const choices = [...open.filter((s) => !s.id), ...open.filter((s) => s.id)];
  return (
    <>
      <div className="label">Place a player</div>
      <div className="seeding-now">{who(p.id)}</div>
      {err}
      <div className="seeding-pick">
        <div className="label">Choose a slot</div>
        {choices.length ? (
          <ul>
            {choices.map((s) => (
              <li key={s.m.id + s.side}>
                <button type="button" className="seeding-opt" onClick={() => act(s, p.id)}>
                  <span className="seeding-where">{s.where.replace(' slot', '')}</span>
                  {s.id ? <span className="seeding-for">Replace {day.players.find((x) => x.id === s.id)?.name ?? 'Unknown player'}</span> : <span className="seeding-for free">Free slot</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No slot can be changed right now.</p>
        )}
      </div>
      {closeBtn}
    </>
  );
}
