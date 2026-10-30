import { useEffect, useState } from 'react';
import type { SteamLogin, Store } from '../lib/types.ts';
import { LOOKUP_WINDOW_MS } from '../lib/steam.ts';
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

/**
 * The Steam Guard code on a store's card. The server only sends a code the card may show (see cardOtp): the code while it
 * lasts, with Logged in and Check for new code when a team signs in on several PCs; "Waiting for a new Steam email…"
 * after a lookup was started; the Get code button when the server can ask; and the plain "call HQ" line whenever there
 * is no code. A code the team has moved past is hidden here at once, without waiting for the server's word.
 */
function OtpBlock({ storeId, login, hqPhone, compact }: { storeId: string; login: SteamLogin; hqPhone?: string; compact?: boolean }) {
  const now = useNow(1000);
  const [asked, setAsked] = useState<SteamLogin['otpLookup']>();
  const [hiddenThrough, setHiddenThrough] = useState<string | undefined>(); // receivedAt of the newest code hidden here
  const [doneThrough, setDoneThrough] = useState<string | undefined>(); // requestedAt of the newest lookup ended here
  const [busy, setBusy] = useState(false);
  const lookup = [asked, login.otpLookup]
    .filter((x): x is NonNullable<typeof x> => !!x && !(doneThrough && Date.parse(x.requestedAt) <= Date.parse(doneThrough)))
    .sort((p, q) => Date.parse(p.requestedAt) - Date.parse(q.requestedAt))
    .pop();
  const otp = login.otp;
  const live = otp && Date.parse(otp.expiresAt) > now && !(hiddenThrough && Date.parse(otp.receivedAt) <= Date.parse(hiddenThrough)) ? otp : undefined;
  const waiting = !live && login.otpRequest && lookup && now - Date.parse(lookup.requestedAt) < LOOKUP_WINDOW_MS ? lookup.requestedAt : undefined;

  /** Starts a lookup — Get code, or Check for new code (`seen`: the code on screen, which then stays hidden). */
  const request = async (seen?: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/steam/otp-request', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, seen }) });
      const body = (await res.json().catch(() => ({}))) as { requestId?: string; requestedAt?: string; error?: string };
      if (!res.ok || !body.requestId || !body.requestedAt) void notify(body.error ? `Couldn’t ask for the code: ${body.error}` : 'Couldn’t ask for the code. Call HQ.');
      else {
        if (seen) setHiddenThrough(seen);
        setAsked({ id: body.requestId, requestedAt: body.requestedAt });
      }
    } catch {
      void notify('Couldn’t reach the server. Check the connection, or call HQ.');
    } finally {
      setBusy(false);
    }
  };

  /** "Logged in": this code is done with — hidden at once, and the server told so it stays gone on every phone. */
  const dismiss = async (receivedAt: string) => {
    setHiddenThrough(receivedAt);
    if (lookup) setDoneThrough(lookup.requestedAt);
    setBusy(true);
    try {
      const res = await fetch('/api/steam/otp-dismiss', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, receivedAt }) });
      if (!res.ok) throw new Error('refused');
    } catch {
      void notify('Couldn’t reach the server. Check the connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {live && <OtpCode code={live.code} expiresAt={live.expiresAt} now={now} />}
      {live && login.otpRequest && (
        <>
          <div className="sc-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void dismiss(live.receivedAt)}>
              Logged in
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void request(live.receivedAt)}>
              Check for new code
            </button>
          </div>
          <p className="sc-hint">Signing in on another PC? Press Check for new code, then sign in — Steam emails a new code each time.</p>
        </>
      )}
      {waiting && (
        <>
          <p className="sc-wait" role="status">
            Waiting for a new Steam email… ({clock(now - Date.parse(waiting))})
          </p>
          <p className="sc-hint">Start the Steam sign-in on the PC — Steam only emails a code when a PC signs in.</p>
        </>
      )}
      {!live && !waiting && login.otpRequest && (
        <>
          <button type="button" className="btn sc-ask" disabled={busy} onClick={() => void request()}>
            {busy ? 'Asking…' : 'Get code'}
          </button>
          <p className="sc-hint">Press Get code, then sign in to Steam on the PC — Steam emails the code only then.</p>
        </>
      )}
      {!live && (
        <p className="sc-otp">
          {compact ? 'No code? Call HQ' : `${waiting ? 'No code yet? ' : ''}For the Steam Guard code (OTP), call HQ`}
          {hqPhone ? ': ' : '.'}
          {hqPhone && (
            <a href={`tel:${hqPhone.replace(/[^\d+]/g, '')}`} className="sc-call">
              {hqPhone}
            </a>
          )}
        </p>
      )}
    </>
  );
}

export const DOWNLOAD_TIP = 'Downloading: many PCs can download at once with this account.';
export const PLAY_TIP = 'Playing: only one PC can be online with it at a time. To play on all PCs, start the game once online, then turn off Wi-Fi and play offline.';

/** Steam ID and password with Copy, then the two tips on sharing the account. */
function LoginDetails({ login }: { login: SteamLogin }) {
  const play = login.purpose === 'play';
  return (
    <>
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
    </>
  );
}

/**
 * The match-day version: a thin strip above the tabs. Steam ID and "Login details" on one row; the ID, password and tips
 * open on demand (remembered per store for this tab), while the Steam Guard code block is always there.
 */
function SteamStrip({ storeId, login, hqPhone }: { storeId: string; login: SteamLogin; hqPhone?: string }) {
  const play = login.purpose === 'play';
  const memo = `fd.steamOpen.${storeId}`;
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(memo) === 'open';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const now = !open;
    setOpen(now);
    try {
      sessionStorage.setItem(memo, now ? 'open' : 'closed');
    } catch {
      /* private mode — it just starts closed again */
    }
  };
  return (
    <section className="sc sc-strip" aria-label="Steam account for this store">
      <div className="sc-strip-row">
        <h3 className="sc-title">Steam</h3>
        <span className={play ? 'chip ok' : 'chip warn'}>{play ? 'For playing' : 'For downloads only'}</span>
        <span className="sc-strip-id" title={login.username}>
          {login.username}
        </span>
        <button type="button" className="btn ghost sc-strip-toggle" aria-expanded={open} aria-controls={`sc-details-${storeId}`} onClick={toggle}>
          Login details
        </button>
      </div>
      {open && (
        <div id={`sc-details-${storeId}`}>
          <LoginDetails login={login} />
        </div>
      )}
      <OtpBlock storeId={storeId} login={login} hqPhone={hqPhone} compact />
    </section>
  );
}

/**
 * The store team's Steam login (Store.steamLogin, worked out by the server for that store only): Steam ID,
 * password, what it is for, and how Steam lets several PCs share it. Renders nothing when HQ hasn't given
 * the store an account. `hqPhone`, when the app has one, turns "call HQ" into a tap-to-call link. `compact`
 * (match day) is the thin strip above the tabs instead of the full card.
 */
export function SteamCard({ store, hqPhone, compact }: { store: Pick<Store, 'id' | 'steamLogin'>; hqPhone?: string; compact?: boolean }) {
  const login = store.steamLogin;
  if (!login) return null;
  if (compact) return <SteamStrip storeId={store.id} login={login} hqPhone={hqPhone} />;
  const play = login.purpose === 'play';
  return (
    <section className="sc" aria-label="Steam account for this store">
      <div className="sc-head">
        <h3 className="sc-title">Steam account for this store</h3>
        <span className={play ? 'chip ok' : 'chip warn'}>{play ? 'For playing' : 'For downloads only'}</span>
      </div>
      <LoginDetails login={login} />
      <OtpBlock storeId={store.id} login={login} hqPhone={hqPhone} />
    </section>
  );
}
