import { useEffect, useState } from 'react';
import type { Store } from '../lib/types.ts';
import { notify, toast } from './ui.tsx';
import '../styles/steam.css';

/** Puts text on the clipboard, with a quiet "copied" — or, where the browser refuses, the text itself to copy by hand. */
export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    void notify(`Copy this ${what.toLowerCase()}: ${text}`);
  }
}

/** A password: dots until it is tapped; Show hides itself again after half a minute. Copy works either way. */
export function SecretValue({ value, what = 'Password' }: { value: string; what?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 30000);
    return () => clearTimeout(t);
  }, [shown]);
  return (
    <span className="sc-value">
      <button type="button" className={shown ? 'sc-text shown' : 'sc-text'} onClick={() => setShown((s) => !s)} aria-label={shown ? `Hide ${what.toLowerCase()}` : `Show ${what.toLowerCase()}`} title={shown ? 'Tap to hide' : 'Tap to show'}>
        {shown ? value : '••••••••••'}
      </button>
      <button type="button" className="btn ghost sc-copy" onClick={() => void copyText(value, what)}>
        Copy
      </button>
    </span>
  );
}

/** A plain value with its Copy button. */
export function CopyValue({ value, what }: { value: string; what: string }) {
  return (
    <span className="sc-value">
      <span className="sc-text static">{value}</span>
      <button type="button" className="btn ghost sc-copy" onClick={() => void copyText(value, what)}>
        Copy
      </button>
    </span>
  );
}

export const DOWNLOAD_TIP = 'Downloading: many PCs can download at once with this account.';
export const PLAY_TIP = 'Playing: only one PC can be online with it at a time. To play on all PCs, start the game once online, then turn off Wi-Fi and play offline.';

/**
 * The store team's Steam login (Store.steamLogin, worked out by the server for that store only): Steam ID,
 * password, what it is for, and how Steam lets several PCs share it. Renders nothing when HQ hasn't given
 * the store an account. `hqPhone`, when the app has one, turns "call HQ" into a tap-to-call link.
 */
export function SteamCard({ store, hqPhone }: { store: Pick<Store, 'steamLogin'>; hqPhone?: string }) {
  const login = store.steamLogin;
  if (!login) return null;
  const play = login.purpose === 'play';
  return (
    <section className="sc" aria-label="Steam account for this store">
      <div className="sc-head">
        <h3 className="sc-title">Steam account for this store</h3>
        <span className={play ? 'chip ok' : 'chip warn'}>{play ? 'For playing' : 'For downloads only'}</span>
      </div>
      <dl className="sc-fields">
        <div>
          <dt>Steam ID</dt>
          <dd>
            <CopyValue value={login.username} what="Steam ID" />
          </dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>
            <SecretValue value={login.password} />
          </dd>
        </div>
      </dl>
      <ul className="sc-tips">
        <li className={play ? undefined : 'lead'}>{DOWNLOAD_TIP}</li>
        <li className={play ? 'lead' : undefined}>{PLAY_TIP}</li>
      </ul>
      <p className="sc-otp">
        For the Steam Guard code (OTP), call HQ{hqPhone ? ': ' : '.'}
        {hqPhone && (
          <a href={`tel:${hqPhone.replace(/[^\d+]/g, '')}`} className="sc-call">
            {hqPhone}
          </a>
        )}
      </p>
    </section>
  );
}
