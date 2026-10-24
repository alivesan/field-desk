import { useState } from 'react';
import { getState, updateStore, useApp } from '../lib/db.ts';
import type { SteamAccount, SteamPurpose, Store } from '../lib/types.ts';
import { campaignStoreNames, storeShortName } from '../lib/names.ts';
import { conflictMessage, purposeLabel, sortedAccounts, steamAccountName, steamAvailability, steamConflicts, storeWeekend, weekendKeyLabel, weekendPhrase } from '../lib/steam.ts';
import { cx, todayLocal } from '../lib/util.ts';
import { Sheet } from './Sheet.tsx';
import { askConfirm, Chip, toast } from './ui.tsx';
import '../styles/steam.css';

/** Short store names for lists: "Incredible Technologies" for the whole "ASUS ROG Exclusive Store — …" name. */
export function useShortStoreName() {
  const stores = useApp((s) => s.stores);
  return (store: { name: string; eventId: string }) => storeShortName(store.name, campaignStoreNames(Object.values(stores), store.eventId));
}

/**
 * HQ: this store's Steam account for its weekend — which one, and for what (play: one store per weekend;
 * downloads: any number). The first step before a recce or match day. Mounted on each store row of the
 * campaign page; the picker shows every account with who holds it that weekend, and refuses a second play.
 */
export function SteamAssign({ store }: { store: Store }) {
  const accounts = useApp((s) => s.accounts);
  const short = useShortStoreName();
  const [open, setOpen] = useState(false);
  const given = store.steam ? accounts[store.steam.accountId] : undefined;

  const unassign = async () => {
    const name = given ? steamAccountName(given) : 'this account';
    if (!(await askConfirm(`Take ${name} away from ${short(store)}? Its team stops seeing the login.`, { ok: 'Unassign', danger: true }))) return;
    updateStore(store.id, (s) => {
      delete s.steam;
    });
    toast('Steam account unassigned');
  };

  return (
    <div className="sa">
      {store.steam ? (
        <div className="sa-given">
          <span className="label">Steam</span>
          <strong className="sa-name">{given ? steamAccountName(given) : 'An account that has been deleted'}</strong>
          <Chip tone={store.steam.purpose === 'play' ? 'ok' : 'muted'}>{purposeLabel(store.steam.purpose)}</Chip>
          <button type="button" className="link" onClick={() => setOpen(true)}>
            Change
          </button>
          <button type="button" className="link warn" onClick={unassign}>
            Unassign
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Assign Steam account
        </button>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} label="Assign a Steam account">
        <Picker store={store} onClose={() => setOpen(false)} />
      </Sheet>
    </div>
  );
}

function Picker({ store, onClose }: { store: Store; onClose: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const short = useShortStoreName();
  const [purpose, setPurpose] = useState<SteamPurpose>(store.steam?.purpose ?? 'play');
  const [refused, setRefused] = useState<{ account: SteamAccount; message: string } | null>(null);

  const world = { events, stores };
  const week = storeWeekend(world, store);
  const today = todayLocal();
  const when = week ? weekendPhrase(week, today) : 'that weekend';
  const list = sortedAccounts(accounts);

  const give = (account: SteamAccount, as: SteamPurpose) => {
    updateStore(store.id, (s) => {
      s.steam = { accountId: account.id, purpose: as, assignedAt: new Date().toISOString() };
    });
    toast(`${steamAccountName(account)} given to ${short(store)} for ${as === 'play' ? 'playing' : 'downloads'}`);
    onClose();
  };
  const choose = (account: SteamAccount) => {
    // Judged against the state as it is right now, not as it was when the sheet opened.
    const now = getState();
    const clashes = steamConflicts(now, store.id, account.id, purpose);
    if (clashes.length) setRefused({ account, message: conflictMessage(clashes, (n) => storeShortName(n, campaignStoreNames(Object.values(now.stores), store.eventId)), when) });
    else give(account, purpose);
  };

  return (
    <div className="sa-sheet">
      <h2 className="sheet-title">Steam account</h2>
      <p className="sa-sub">
        {short(store)}
        {week && (
          <>
            {' · '}
            {weekendKeyLabel(week)}
          </>
        )}
      </p>

      <div className="field">
        <span className="label">What for</span>
        <div className="seg" role="radiogroup" aria-label="What the account is for">
          {(['play', 'download'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={purpose === p}
              className={cx(purpose === p && 'on')}
              onClick={() => {
                setPurpose(p);
                setRefused(null);
              }}
            >
              {p === 'play' ? 'Play' : 'Downloads'}
            </button>
          ))}
        </div>
        <p className="hint">{purpose === 'play' ? 'Only one store can play with an account in a weekend — one PC is online at a time.' : 'Downloads can be shared: any number of stores, and the recce.'}</p>
      </div>

      {refused && (
        <div className="sa-refused" role="alert">
          <p>{refused.message}</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => give(refused.account, 'download')}>
              Assign for downloads
            </button>
            <button type="button" className="btn ghost" onClick={() => setRefused(null)}>
              Pick another
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <p className="empty">
          No Steam accounts yet. <a href="#/steam">Add them on the Steam accounts page</a>, then come back.
        </p>
      ) : (
        <ul className="sa-picks">
          {list.map((a) => {
            const av = steamAvailability(world, store, a.id);
            const blocked = purpose === 'play' && !av.canPlay;
            return (
              <li key={a.id}>
                <button type="button" className={cx('sa-pick', av.mine && 'mine', blocked && 'blocked')} onClick={() => choose(a)}>
                  <span className="sa-pick-name">
                    <strong>{a.label?.trim() || a.username}</strong>
                    {a.label?.trim() && <small>{a.username}</small>}
                  </span>
                  <span className="sa-pick-state">
                    {av.mine && <Chip tone="ok">Given to this store · {purposeLabel(store.steam!.purpose)}</Chip>}
                    {av.playingAt.length > 0 && <Chip tone="warn">Playing at {av.playingAt.map((s) => short(s)).join(', ')}</Chip>}
                    {av.playingAt.length > 0 && <Chip tone="muted">Downloads only</Chip>}
                    {av.downloadingAt.length > 0 && <Chip tone="muted">Downloads at {av.downloadingAt.map((s) => short(s)).join(', ')}</Chip>}
                    {!av.mine && !av.playingAt.length && !av.downloadingAt.length && <Chip tone="ok">Free</Chip>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
