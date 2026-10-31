import { useState } from 'react';
import { MAX_IGN } from '../lib/phone.ts';
import type { Player } from '../lib/types.ts';
import '../styles/checkin.css';

/** What the edit form may send (players.edit): only what changed. */
export interface PlayerEdit {
  name?: string;
  ign?: string;
  phone?: string;
}

/** The player edit form, used in the check-in card (PlayerSheet) and on HQ’s Players & bracket page: HQ edits name, in-game name and number; the desk gets the number (when there is none) and the in-game name. Sends only what changed. */
export function PlayerEditForm({ player: p, hq, phone: withPhone, onSave, onCancel }: { player: Player; hq: boolean; phone: boolean; onSave: (edit: PlayerEdit) => string | null; onCancel: () => void }) {
  const [name, setName] = useState(p.name);
  const [phone, setPhone] = useState(p.phone ?? '');
  const [ign, setIgn] = useState(p.ign ?? '');
  const [problem, setProblem] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const edit: PlayerEdit = {};
    if (hq && name.trim() !== p.name) edit.name = name;
    if (withPhone && phone.trim() !== (p.phone ?? '')) edit.phone = phone;
    if (ign.trim() !== (p.ign ?? '')) edit.ign = ign;
    if (!Object.keys(edit).length) return hq || !withPhone ? onCancel() : setProblem('Type the number.');
    const refused = onSave(edit);
    if (refused) setProblem(refused);
  };
  return (
    <form className="sheet-edit" onSubmit={submit} noValidate>
      <div className="label">{hq ? 'Edit player' : withPhone ? 'Add a number' : 'In-game name'}</div>
      {hq && (
        <label className="field">
          <span className="label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" autoCapitalize="words" enterKeyHint="next" />
        </label>
      )}
      {withPhone && (
        <label className="field">
          <span className="label">Phone</span>
          <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={24} autoComplete="off" enterKeyHint="next" placeholder={hq ? 'Empty removes the number' : 'Lets them use the QR'} autoFocus={!hq} />
        </label>
      )}
      <label className="field">
        <span className="label">In-game name</span>
        <input value={ign} onChange={(e) => setIgn(e.target.value)} maxLength={MAX_IGN} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder="Optional" />
      </label>
      {problem && (
        <div className="onspot-msg problem" role="alert">
          <span>{problem}</span>
        </div>
      )}
      <div className="sheet-buttons">
        <button type="submit" className="btn accent">
          Save
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
