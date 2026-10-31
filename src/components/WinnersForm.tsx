import { useRef, useState } from 'react';
import type { WinnerInput } from '../lib/command-types.ts';
import { prettyPhone } from '../lib/onspot.ts';
import { isPhone, MAX_IGN } from '../lib/phone.ts';
import type { MatchDay, Player, WinnerDetails } from '../lib/types.ts';
import { cleanWinnerInput, FIELD_LABEL, MAX_EMAIL, MAX_REAL_NAME, missingFields, parseEmail, parseInstagram, type FinalResult, type WinnerField, type Who } from '../lib/winnerInput.ts';
import { cx, fmtTime } from '../lib/util.ts';
import { success } from '../lib/haptics.ts';
import { Sheet } from './Sheet.tsx';
import { toast } from './ui.tsx';
import '../styles/winners-form.css';

/*
 * The desk's form for the winner and the runner-up, in a sheet (a bottom sheet on a phone). Who
 * they are comes from the final; the name, in-game name and phone start from the player list and
 * are the admin's to correct, the email and Instagram are typed. Saving sends winners.set, whose
 * server rules (src/lib/tournament.ts) are the same cleaning shown here as inline hints.
 */

export interface Draft {
  realName: string;
  ign: string;
  phone: string;
  email: string;
  instagram: string;
}
type Field = keyof Draft;
const FIELDS = ['phone', 'email', 'instagram'] as const;

export const asInput = (d: Draft): WinnerInput => ({ realName: d.realName, ign: d.ign, phone: d.phone, email: d.email, instagram: d.instagram });

/** What the form starts with: the saved record for this very person, else the player list. */
function initial(saved: WinnerDetails | undefined, id: string, p: Player | undefined): Draft {
  if (saved && saved.playerId === id) return { realName: saved.realName, ign: saved.ign ?? '', phone: prettyPhone(saved.phone), email: saved.email ?? '', instagram: saved.instagram ?? '' };
  // A finalist is checked in, so an admin has the number by now; if it hasn't arrived yet the field just starts empty.
  return { realName: p?.name ?? '', ign: p?.ign ?? '', phone: prettyPhone(p?.phone), email: '', instagram: '' };
}

/** A plain hint for a field that won't be accepted, or null. */
function fieldProblem(f: Field, v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (f === 'phone' && !isPhone(t)) return 'Type 8–15 digits.';
  if (f === 'email' && parseEmail(t) === null) return 'Doesn’t look like an email — name@example.com.';
  if (f === 'instagram' && parseInstagram(t) === null) return 'Letters, digits, “.” and “_” only.';
  return null;
}

export function WinnersSheet({
  open,
  onClose,
  day,
  result,
  matchLabel,
  save,
}: {
  open: boolean;
  onClose: () => void;
  day: MatchDay;
  result: FinalResult | null;
  matchLabel: string;
  save: (winner: WinnerInput, runnerUp: WinnerInput) => string | null; // the refusal, or null once queued
}) {
  return (
    <Sheet open={open && !!result} onClose={onClose} label="Winner details">
      {result && <WinnersForm day={day} result={result} matchLabel={matchLabel} save={save} onClose={onClose} />}
    </Sheet>
  );
}

function WinnersForm({ day, result, matchLabel, save, onClose }: { day: MatchDay; result: FinalResult; matchLabel: string; save: (w: WinnerInput, r: WinnerInput) => string | null; onClose: () => void }) {
  const byId = (id: string) => day.players.find((p) => p.id === id);
  const saved = day.winners && day.winners.winner.playerId === result.winner && day.winners.runnerUp.playerId === result.runnerUp ? day.winners : undefined;
  const [win, setWin] = useState<Draft>(() => initial(saved?.winner, result.winner, byId(result.winner)));
  const [run, setRun] = useState<Draft>(() => initial(saved?.runnerUp, result.runnerUp, byId(result.runnerUp)));
  const [shown, setShown] = useState(false); // inline hints for untouched fields wait for the first Save
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setShown(true);
    setError(null);
    for (const [d, who] of [[win, 'Winner'], [run, 'Runner-up']] as [Draft, Who][]) {
      const c = cleanWinnerInput(asInput(d), who);
      if (!c.ok) {
        setError(c.error);
        // Bring the first field with a hint into view (the sheet scrolls on a phone).
        requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('.wf-field.bad input')?.focus());
        return;
      }
    }
    const refused = save(asInput(win), asInput(run));
    if (refused) return setError(refused);
    success();
    toast('Winner details saved');
    onClose();
  };

  return (
    <form className="wf" ref={formRef} onSubmit={submit} noValidate aria-labelledby="wf-h">
      <div className="label">Final · {matchLabel}</div>
      <h2 id="wf-h" className="sheet-title">
        Winner details
      </h2>
      <p className="hint">
        Name, in-game name and phone are filled in from the player list — correct them if they’re not the person’s real details. The name and phone are needed to send the prize; email and Instagram help.
      </p>
      {saved && (
        <p className="wf-saved">
          Saved {fmtTime(saved.updatedAt)} by {saved.by} — you’re editing what’s saved.
        </p>
      )}
      <Person who="Winner" medal="🏆" listName={byId(result.winner)?.name ?? 'Unknown player'} draft={win} onChange={setWin} shown={shown} />
      <Person who="Runner-up" medal="🥈" listName={byId(result.runnerUp)?.name ?? 'Unknown player'} draft={run} onChange={setRun} shown={shown} />
      {error && (
        <div className="wf-msg" role="alert">
          {error}
        </div>
      )}
      <div className="wf-actions">
        <button type="submit" className="btn accent">
          {saved ? 'Save changes' : 'Save details'}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One person's fields; HQ's hand-entry form (WinnersManual.tsx) reuses it. */
export function Person({ who, medal, listName, draft, onChange, shown, children }: { who: Who; medal: string; listName?: string; draft: Draft; onChange: (d: Draft) => void; shown: boolean; children?: React.ReactNode }) {
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const id = who === 'Winner' ? 'win' : 'run';
  const set = (f: Field) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draft, [f]: e.target.value });
  const typed = missingFields({ realName: draft.realName.trim(), phone: draft.phone.trim(), email: draft.email.trim(), instagram: draft.instagram.trim() });
  const unusable: WinnerField[] = FIELDS.filter((f) => fieldProblem(f, draft[f]));
  const missing = typed.filter((f) => !unusable.includes(f));
  const block = (f: Field, label: string, input: (p: { id: string; 'aria-describedby'?: string }) => React.ReactNode, className?: string) => {
    const problem = (shown || touched[f]) && fieldProblem(f, draft[f]);
    return (
      <div
        className={cx('field wf-field', className, problem && 'bad')}
        onBlur={() => {
          setTouched((t) => ({ ...t, [f]: true }));
          // A pasted link or "@name" settles to the bare handle, so the admin sees what is stored.
          const handle = f === 'instagram' ? parseInstagram(draft.instagram) : null;
          if (handle && handle !== draft.instagram) onChange({ ...draft, instagram: handle });
        }}
      >
        <label className="label" htmlFor={`wf-${id}-${f}`}>
          {label}
        </label>
        {input({ id: `wf-${id}-${f}`, ...(problem ? { 'aria-describedby': `wf-${id}-${f}-e` } : {}) })}
        {problem && (
          <span className="wf-hint" id={`wf-${id}-${f}-e`}>
            {problem}
          </span>
        )}
      </div>
    );
  };
  return (
    <fieldset className="wf-person">
      <legend>
        <span aria-hidden>{medal}</span> {who}
        {listName && <small>{listName}</small>}
      </legend>
      {children}
      {block('realName', 'Real name', (p) => (
        <input {...p} value={draft.realName} onChange={set('realName')} maxLength={MAX_REAL_NAME} autoComplete="off" autoCapitalize="words" enterKeyHint="next" placeholder="Full name, as on their ID" />
      ))}
      <div className="grid2">
        {block('ign', 'In-game name', (p) => (
          <input {...p} value={draft.ign} onChange={set('ign')} maxLength={MAX_IGN} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" placeholder="Optional" />
        ))}
        {block('phone', 'Phone', (p) => (
          <input {...p} type="tel" inputMode="tel" value={draft.phone} onChange={set('phone')} maxLength={24} autoComplete="off" enterKeyHint="next" placeholder="e.g. 98200 11111" />
        ))}
      </div>
      <div className="grid2">
        {block('email', 'Email', (p) => (
          <input {...p} type="email" inputMode="email" value={draft.email} onChange={set('email')} maxLength={MAX_EMAIL} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" placeholder="name@example.com" />
        ))}
        {block(
          'instagram',
          'Instagram',
          (p) => (
            <span className="wf-at">
              <span aria-hidden>@</span>
              <input {...p} inputMode="text" value={draft.instagram} onChange={set('instagram')} maxLength={80} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder="handle" />
            </span>
          ),
          'wf-ig',
        )}
      </div>
      <p className={cx('wf-missing', !missing.length && !unusable.length && 'ok')} aria-live="polite">
        {missing.length || unusable.length
          ? [missing.length && `Still missing: ${missing.map((f) => FIELD_LABEL[f]).join(', ')}`, unusable.length && `Fix: ${unusable.map((f) => FIELD_LABEL[f]).join(', ')}`].filter(Boolean).join(' · ')
          : 'Everything collected ✓'}
      </p>
    </fieldset>
  );
}
