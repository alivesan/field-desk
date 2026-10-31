import { useRef, useState } from 'react';
import { dayVersion } from '../lib/commands.ts';
import { prettyPhone } from '../lib/onspot.ts';
import type { Store, WinnerDetails } from '../lib/types.ts';
import { cleanWinnerInput, type Who } from '../lib/winnerInput.ts';
import { fmtTime } from '../lib/util.ts';
import { success } from '../lib/haptics.ts';
import { asInput, Person, type Draft } from './WinnersForm.tsx';
import { useHqCommand } from './hqCommand.ts';
import { Sheet } from './Sheet.tsx';
import { toast } from './ui.tsx';
import '../styles/winners-form.css';

/*
 * HQ's form for a store whose bracket ran elsewhere (Toornament): type the winner and runner-up by
 * hand. Same fields and hints as the desk's form (WinnersForm.tsx); nothing is checked against the
 * bracket. Only the winner's name is required — the runner-up may stay empty. Saving sends
 * winners.manual; "Pick from the player list" just fills the fields in.
 */

const blank: Draft = { realName: '', ign: '', phone: '', email: '', instagram: '' };
const draftOf = (d: WinnerDetails | undefined): Draft => (d ? { realName: d.realName, ign: d.ign ?? '', phone: prettyPhone(d.phone), email: d.email ?? '', instagram: d.instagram ?? '' } : blank);

export function ManualWinnersSheet({ open, onClose, store }: { open: boolean; onClose: () => void; store: Store }) {
  return (
    <Sheet open={open} onClose={onClose} label="Enter winners by hand">
      <ManualForm store={store} onClose={onClose} />
    </Sheet>
  );
}

function ManualForm({ store, onClose }: { store: Store; onClose: () => void }) {
  const send = useHqCommand();
  const saved = store.day.winners?.manual ? store.day.winners : undefined;
  const [win, setWin] = useState<Draft>(() => draftOf(saved?.winner));
  const [run, setRun] = useState<Draft>(() => draftOf(saved?.runnerUp));
  const [shown, setShown] = useState(false); // inline hints for untouched fields wait for the first Save
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const players = [...store.day.players].sort((a, b) => a.name.localeCompare(b.name));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setShown(true);
    setError(null);
    for (const [d, who] of [[win, 'Winner'], [run, 'Runner-up']] as [Draft, Who][]) {
      const c = cleanWinnerInput(asInput(d), who);
      if (!c.ok || (who === 'Winner' && !c.value.realName)) {
        setError(c.ok ? 'Type the winner’s name.' : c.error);
        requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('.wf-field.bad input, #wf-win-realName')?.focus());
        return;
      }
    }
    const refused = send(store.id, (s) => ({ type: 'winners.manual', base: dayVersion(s), winner: asInput(win), runnerUp: asInput(run) }));
    if (refused) return setError(refused);
    success();
    toast('Winner details saved');
    onClose();
  };

  /** A select that fills one person's fields from the player list. */
  const pick = (who: Who, onChange: (d: Draft) => void) =>
    players.length > 0 && (
      <label className="field wf-pick">
        <span className="label">Pick {who === 'Winner' ? 'the winner' : 'the runner-up'} from the player list</span>
        <select
          value=""
          onChange={(e) => {
            const p = players.find((x) => x.id === e.target.value);
            if (p) onChange({ ...blank, realName: p.name, ign: p.ign ?? '', phone: prettyPhone(p.phone) });
          }}
        >
          <option value="">Type them below instead</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.ign ? ` (${p.ign})` : ''}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <form className="wf" ref={formRef} onSubmit={submit} noValidate aria-labelledby="wf-h">
      <div className="label">{store.name}</div>
      <h2 id="wf-h" className="sheet-title">
        Enter winners by hand
      </h2>
      <p className="hint">For a store whose bracket ran elsewhere. Only the winner’s name is needed — leave the runner-up empty if you don’t have them yet. Nothing here is checked against the bracket.</p>
      {saved && (
        <p className="wf-saved">
          Entered {fmtTime(saved.updatedAt)} by {saved.by} — you’re editing what’s saved.
        </p>
      )}
      <Person who="Winner" medal="🏆" draft={win} onChange={setWin} shown={shown}>
        {pick('Winner', setWin)}
      </Person>
      <Person who="Runner-up" medal="🥈" draft={run} onChange={setRun} shown={shown}>
        {pick('Runner-up', setRun)}
      </Person>
      {error && (
        <div className="wf-msg" role="alert">
          {error}
        </div>
      )}
      <div className="wf-actions">
        <button type="submit" className="btn accent">
          {saved ? 'Save changes' : 'Save winners'}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
