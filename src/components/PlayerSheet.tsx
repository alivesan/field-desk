import { prettyPhone } from '../lib/onspot.ts';
import { isSelf } from '../lib/checkin.ts';
import { numberAccess, phoneTail, telFor } from '../lib/day-ui.ts';
import type { MatchDay, OnSpotEntry, Player } from '../lib/types.ts';
import { cx, fmtTime } from '../lib/util.ts';
import { Sheet } from './Sheet.tsx';

/**
 * Tap a player in the Check-in list: their name and number, and Call — which on a phone dials
 * straight away. The list itself stays masked (shared screens); the full number is only here, and
 * for a field admin only once the player is checked in (HQ can always call).
 */
export function PlayerSheet({
  player,
  day,
  hq,
  onSpot,
  onToggle,
  onClose,
}: {
  player: Player | null;
  day: MatchDay;
  hq: boolean;
  onSpot: OnSpotEntry | undefined;
  onToggle: (p: Player) => void; // check in, or (after asking) undo — the same action as the row's button
  onClose: () => void;
}) {
  const p = player;
  const at = p ? day.checkIn[p.id] : undefined;
  const access = p ? numberAccess(p, !!at, hq) : 'none';
  const tel = p ? telFor(p, !!at, hq) : null;
  const tail = p ? phoneTail(p) : '';
  return (
    <Sheet open={!!p} onClose={onClose} label={p ? `${p.name} — contact` : 'Player'}>
      {p && (
        <>
          <div className="label">Seed {String(p.seed).padStart(2, '0')}</div>
          <h2 className="sheet-title">{p.name}</h2>
          {p.ign && (
            <div className="ign sheet-ign" title="In-game name">
              {p.ign}
            </div>
          )}
          <div className="sheet-tags">
            <span className={cx('sheet-here', at && 'in')}>
              {at ? `✓ Here since ${fmtTime(at)}` : '○ Not checked in'}
            </span>
            {at && <span className="label">{isSelf(day, p.id) ? 'by QR' : 'at the desk'}</span>}
            {onSpot && (
              <span className="onspot-tag" title="Registered at the desk on the day">
                On spot
              </span>
            )}
          </div>

          {access === 'open' &&
            (tel ? (
              <a className="btn accent call" href={tel}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
                </svg>
                <span className="call-main">
                  <strong>Call</strong>
                  <span>{prettyPhone(p.phone)}</span>
                </span>
              </a>
            ) : (
              <p className="sheet-nophone">The number on the list ({p.phone}) can’t be dialled.</p>
            ))}
          {access === 'after-check-in' && (
            <>
              <p className="sheet-locked">
                <strong>Number shown after check-in</strong>
                {tail && <span>ends {tail}</span>}
              </p>
              <button className="btn accent sheet-checkin" onClick={() => onToggle(p)}>
                Check in {p.name.split(' ')[0]}
              </button>
            </>
          )}
          {access === 'loading' && (
            <p className="sheet-locked" role="status">
              <strong>Getting the number…</strong>
              <span>It appears once the server has the check-in.</span>
            </p>
          )}
          {access === 'none' && <p className="sheet-nophone">No number on the list.</p>}

          <div className="sheet-buttons">
            {access !== 'after-check-in' && (
              <button className={cx('btn', at ? 'ghost' : 'accent')} onClick={() => onToggle(p)}>
                {at ? 'Undo check-in' : 'Check in'}
              </button>
            )}
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
