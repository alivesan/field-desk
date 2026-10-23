import { useState } from 'react';
import { matchNo } from '../lib/bracket.ts';
import type { WinnerInput } from '../lib/command-types.ts';
import type { MatchDay, WinnerDetails } from '../lib/types.ts';
import { FIELD_LABEL, finalResult, missingFields, winnersState } from '../lib/winnerInput.ts';
import { cx, fmtTime } from '../lib/util.ts';
import { WinnersSheet } from './WinnersForm.tsx';
import '../styles/winners-form.css';

/**
 * Match day's winners card: once the final is recorded it names the champion and the runner-up and
 * is the next step — collect their real name, phone, email and Instagram — then shows what's saved
 * and what's still missing. If the final was undone or replayed after saving, it says the saved
 * details no longer match (they are kept; HQ's winners list flags them too).
 */
export function WinnersBanner({
  day,
  names,
  save,
  pending,
  offline,
  hero,
}: {
  day: MatchDay;
  names: Record<string, string>;
  save: (winner: WinnerInput, runnerUp: WinnerInput) => string | null;
  pending: 'sending' | 'queued' | null; // a winners.set on its way
  offline: boolean;
  hero?: boolean; // the queue tab's big champion block
}) {
  const [open, setOpen] = useState(false);
  const ws = winnersState(day);
  if (ws.kind === 'none') return null;
  const result = finalResult(day.matches);
  const w = day.winners;
  const name = (id: string) => names[id] ?? 'Unknown player';
  const matchLabel = result ? `M${matchNo(result.match, day.matches)}` : 'the final';
  const need = (d: WinnerDetails) => {
    const m = missingFields(d);
    return m.length ? m.map((f) => FIELD_LABEL[f]) : null;
  };
  const savedLine = w ? `Saved ${fmtTime(w.updatedAt)} by ${w.by}` : '';
  const cta = (label: string, primary: boolean) => (
    <button className={cx('btn', primary ? 'accent' : 'ghost')} onClick={() => setOpen(true)}>
      {label}
    </button>
  );
  const status = pending ? <span className="label pending-tag">{pending === 'sending' ? 'Saving…' : offline ? 'Queued · offline' : 'Queued'}</span> : null;

  return (
    <section className={cx('wb', hero && 'hero', ws.kind, ws.kind === 'saved' && (ws.missing ? 'incomplete' : 'complete'))} aria-label="Winner details">
      {result && (
        <>
          <span className="label wb-kicker">
            <span aria-hidden>🏆</span> Champion
          </span>
          <h2 className="wb-champ">{name(result.winner)}</h2>
          <p className="wb-line">
            Runner-up: <strong>{name(result.runnerUp)}</strong>
          </p>
        </>
      )}

      {ws.kind === 'stale' ? (
        <div className="wb-stalebox">
          <span className="label wb-warn">Check the winners</span>
          <p className="wb-stale">
            The details saved for <strong>{w!.winner.realName || name(w!.winner.playerId)}</strong> and <strong>{w!.runnerUp.realName || name(w!.runnerUp.playerId)}</strong> no longer match the bracket — the final was undone or has
            other players now. They’re kept as they are.
          </p>
          {result ? (
            <div className="wb-actions">
              {cta('Collect winner details', true)}
              {status}
            </div>
          ) : (
            <p className="wb-line">Record the final again, then check the details.</p>
          )}
        </div>
      ) : ws.kind === 'collect' ? (
        <div className="wb-next">
          <div>
            <span className="label">Next step</span>
            <p>Collect the winner’s and runner-up’s real name, phone, email and Instagram so the prizes can reach them.</p>
          </div>
          <div className="wb-actions">
            {cta('Collect winner details', true)}
            {status}
          </div>
        </div>
      ) : (
        <div className="wb-next">
          <div>
            <span className="label">{ws.missing ? 'Winner details · not complete' : 'Winners: details saved ✓'}</span>
            <ul className="wb-people">
              {([['Winner', w!.winner], ['Runner-up', w!.runnerUp]] as const).map(([who, d]) => {
                const lacks = need(d);
                return (
                  <li key={who} className={cx(!d.realName || !d.phone ? 'must' : lacks && 'maybe')}>
                    <strong>{who}</strong>
                    <span>{d.realName || '—'}</span>
                    <small>{lacks ? `Missing: ${lacks.join(', ')}` : 'Complete'}</small>
                  </li>
                );
              })}
            </ul>
            <p className="wb-when">{savedLine}</p>
          </div>
          <div className="wb-actions">
            {cta(ws.missing ? 'Collect winner details' : 'Edit details', ws.missing)}
            {status}
          </div>
        </div>
      )}
      <WinnersSheet open={open} onClose={() => setOpen(false)} day={day} result={result} matchLabel={matchLabel} save={save} />
    </section>
  );
}
