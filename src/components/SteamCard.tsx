import { useEffect, useState } from 'react';
import type { SteamLogin, Store } from '../lib/types.ts';
import { notify, toast, useNow } from './ui.tsx';
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

/** 612000 ms -> "10:12". */
export function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A Steam Guard code in big type with the time it has left, and Copy. */
export function OtpCode({ code, expiresAt, now }: { code: string; expiresAt: string; now: number }) {
  return (
    <div className="sc-otp-live" role="status">
      <span className="sc-code" aria-label={`Steam Guard code ${code.split('').join(' ')}`}>
        {code}
      </span>
      <button type="button" className="btn ghost sc-copy" onClick={() => void copyText(code, 'Code')}>
        Copy
      </button>
      <span className="sc-expires">expires in {clock(Date.parse(expiresAt) - now)}</span>
    </div>
  );
}

const WAIT_MS = 10 * 60 * 1000;

/**
 * The Steam Guard code on a store's card: the code while it lasts; "Requested — waiting for the email…" after the team
 * asked for one; the Request code button when the server can ask; and the plain "call HQ" line whenever there is no code.
 */
function OtpBlock({ storeId, login, hqPhone }: { storeId: string; login: SteamLogin; hqPhone?: string }) {
  const now = useNow(1000);
  const [asked, setAsked] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const requestedAt = [asked, login.otpRequestedAt].filter((x): x is string => !!x).sort().pop();
  const live = login.otp && Date.parse(login.otp.expiresAt) > now ? login.otp : undefined;
  const waiting = !live && login.otpRequest && requestedAt && now - Date.parse(requestedAt) < WAIT_MS ? requestedAt : undefined;

  const request = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/steam/otp-request', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId }) });
      const body = (await res.json().catch(() => ({}))) as { requestedAt?: string; error?: string };
      if (!res.ok || !body.requestedAt) void notify(body.error ? `Couldn’t ask for the code: ${body.error}` : 'Couldn’t ask for the code. Call HQ.');
      else setAsked(body.requestedAt);
    } catch {
      void notify('Couldn’t reach the server. Check the connection, or call HQ.');
    } finally {
      setBusy(false);
    }
  };

  if (live) return <OtpCode code={live.code} expiresAt={live.expiresAt} now={now} />;
  return (
    <>
      {waiting && (
        <p className="sc-wait" role="status">
          Requested — waiting for the email… ({clock(now - Date.parse(waiting))})
        </p>
      )}
      {!waiting && login.otpRequest && (
        <button type="button" className="btn sc-ask" disabled={busy} onClick={() => void request()}>
          {busy ? 'Asking…' : 'Request code'}
        </button>
      )}
      <p className="sc-otp">
        {waiting ? 'No code yet? ' : ''}For the Steam Guard code (OTP), call HQ{hqPhone ? ': ' : '.'}
        {hqPhone && (
          <a href={`tel:${hqPhone.replace(/[^\d+]/g, '')}`} className="sc-call">
            {hqPhone}
          </a>
        )}
      </p>
    </>
  );
}

export const DOWNLOAD_TIP = 'Downloading: many PCs can download at once with this account.';
export const PLAY_TIP = 'Playing: only one PC can be online with it at a time. To play on all PCs, start the game once online, then turn off Wi-Fi and play offline.';

/**
 * The store team's Steam login (Store.steamLogin, worked out by the server for that store only): Steam ID,
 * password, what it is for, and how Steam lets several PCs share it. Renders nothing when HQ hasn't given
 * the store an account. `hqPhone`, when the app has one, turns "call HQ" into a tap-to-call link.
 */
export function SteamCard({ store, hqPhone }: { store: Pick<Store, 'id' | 'steamLogin'>; hqPhone?: string }) {
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
      <OtpBlock storeId={store.id} login={login} hqPhone={hqPhone} />
    </section>
  );
}
