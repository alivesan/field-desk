import { useEffect, useRef, useState } from 'react';
import { problemFor, problemText, retryAfterSeconds, type CheckInProblem } from '../lib/checkin.ts';
import { isPhone, normalizePhone } from '../lib/phone.ts';
import { fmtDate, fmtTime } from '../lib/util.ts';
import '../styles/checkin.css';

/*
 * Public player check-in (/c/<token>) — what a player sees after scanning the venue QR.
 * Talks only to /api/public/checkin/:token. Must not import db.ts (no sync engine, no storage):
 * nothing is kept on the device, the number lives in this component's state until it's sent.
 * Shows the store and the player's own public name — never anyone else.
 */

interface Info {
  store: string;
  campaign: string;
  date: string;
  open: boolean;
  bracketPath: string; // "/b/<token>" while the store's public bracket is on; '' when it isn't
}

type Load = { kind: 'loading' } | { kind: 'ready'; info: Info } | { kind: 'problem'; problem: CheckInProblem };
type Done = { name: string; already: boolean; at: string };

const TIMEOUT_MS = 15000;
const CLOSED_POLL_MS = 15000;

async function call(token: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown>; retryAfter: string | null }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`/api/public/checkin/${encodeURIComponent(token)}`, { ...init, cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: body && typeof body === 'object' ? body : {}, retryAfter: res.headers.get('Retry-After') };
  } finally {
    clearTimeout(t);
  }
}

const text = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : '');

/** Only our own bracket page is ever linked to: "/b/<token>", nothing else. */
const bracketPathOf = (v: unknown) => (typeof v === 'string' && /^\/b\/[A-Za-z0-9_-]{16,64}$/.test(v) ? v : '');

/** The way on to the live bracket, under a checked-in player's name. */
function FollowBracket({ path }: { path: string }) {
  if (!path) return null; // HQ turned this store's public bracket off
  return (
    <div className="ci-follow">
      <a className="btn accent block ci-btn" href={path}>
        Follow the live bracket
      </a>
      <p className="ci-help">Results and who plays next, live. It goes live here once the bracket is officially out.</p>
    </div>
  );
}

export function CheckInPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CheckInProblem | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, tick] = useState(0);
  const [done, setDone] = useState<Done | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const fetchInfo = async (quiet = false) => {
    if (!quiet) setLoad({ kind: 'loading' });
    try {
      const r = await call(token);
      if (r.status === 200) setLoad({ kind: 'ready', info: { store: text(r.body.store), campaign: text(r.body.campaign), date: text(r.body.date), open: r.body.open !== false, bracketPath: bracketPathOf(r.body.bracketPath) } });
      else setLoad({ kind: 'problem', problem: r.status === 404 ? 'not-found' : problemFor(r.status, text(r.body.code)) });
    } catch {
      if (!quiet) setLoad({ kind: 'problem', problem: 'offline' });
    }
  };

  useEffect(() => {
    void fetchInfo();
  }, [token]);

  const info = load.kind === 'ready' ? load.info : null;

  useEffect(() => {
    document.title = info?.store ? `Check in · ${info.store}` : 'Player check-in';
  }, [info?.store]);

  // Closed: look again every so often, so the form appears when staff open check-in.
  useEffect(() => {
    if (!info || info.open || done) return;
    const t = setInterval(() => void fetchInfo(true), CLOSED_POLL_MS);
    return () => clearInterval(t);
  }, [info?.open, done]);

  // Rate-limited: count down to the next allowed try.
  const wait = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
  useEffect(() => {
    if (!wait) return;
    const t = setTimeout(() => tick((n) => n + 1), 1000);
    return () => clearTimeout(t);
  }, [wait, waitUntil]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || wait) return;
    if (!isPhone(phone)) {
      setProblem('bad-request');
      input.current?.focus();
      return;
    }
    if (globalThis.navigator?.onLine === false) return setProblem('offline');
    setBusy(true);
    setProblem(null);
    try {
      const r = await call(token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: normalizePhone(phone) }) });
      if (r.status === 200 && r.body.ok) {
        setDone({ name: text(r.body.name), already: !!r.body.already, at: new Date().toISOString() });
        setPhone('');
      } else {
        const p = problemFor(r.status, text(r.body.code));
        if (p === 'rate-limited') setWaitUntil(Date.now() + retryAfterSeconds(r.retryAfter) * 1000);
        if (p === 'not-found') return setLoad({ kind: 'problem', problem: p });
        if (p === 'closed' && info) setLoad({ kind: 'ready', info: { ...info, open: false } });
        setProblem(p);
      }
    } catch {
      setProblem('offline');
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setDone(null);
    setProblem(null);
    setPhone('');
    setTimeout(() => input.current?.focus(), 0);
  };

  const head = (
    <div className="ci-kicker">
      {info ? [info.campaign, info.date && fmtDate(info.date, { weekday: 'short', day: 'numeric', month: 'short' })].filter(Boolean).join(' · ') || 'Player check-in' : 'Player check-in'}
    </div>
  );

  if (load.kind === 'loading')
    return (
      <div className="ci">
        <main className="ci-inner" aria-busy="true">
          {head}
          <p className="ci-wait">Loading…</p>
        </main>
      </div>
    );

  if (load.kind === 'problem') {
    const t = problemText(load.problem);
    return (
      <div className="ci">
        <main className="ci-inner">
          {head}
          <h1>{t.title}</h1>
          <p className="ci-deck">{t.body}</p>
          {load.problem !== 'not-found' && (
            <button className="btn block ci-btn" onClick={() => void fetchInfo()}>
              Try again
            </button>
          )}
        </main>
      </div>
    );
  }

  const where = info!.store;

  if (done)
    return (
      <div className="ci">
        <main className="ci-inner ci-done" role="status">
          <div className="ci-kicker ok">
            {done.already ? 'Already checked in' : 'Checked in'} · {fmtTime(done.at)}
          </div>
          <span className="ci-tick" aria-hidden />
          <h1>
            {done.already ? 'You’re already checked in' : 'You’re checked in'}
            {done.name ? (
              <>
                , <span className="ci-name">{done.name}</span>
                {done.name.endsWith('.') ? '' : '.'}
              </>
            ) : (
              '.'
            )}
          </h1>
          <p className="ci-deck">Stay close — your match will be called on the screen{where ? ` at ${where}` : ''}.</p>
          <FollowBracket path={info!.bracketPath} />
          <div className="ci-notyou">
            <strong>Not you?</strong> The number may have been mistyped. Tell the staff at the desk so they can fix it, then{' '}
            <button className="link" onClick={again}>
              check the number again
            </button>
            .
          </div>
        </main>
      </div>
    );

  const t = problem ? problemText(problem, wait) : null;
  return (
    <div className="ci">
      <main className="ci-inner">
        {head}
        <h1>Check in{where ? <span className="ci-store"> at {where}</span> : null}.</h1>
        {info!.open ? (
          <form onSubmit={submit} noValidate>
            <label className="ci-field">
              <span className="label">Your phone number</span>
              <input
                ref={input}
                autoFocus
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                name="phone"
                maxLength={20}
                placeholder="98200 11111"
                value={phone}
                aria-invalid={problem === 'bad-request' || problem === 'no-match'}
                aria-describedby="ci-help"
                onChange={(e) => {
                  setPhone(e.target.value.replace(/[^\d\s+()-]/g, ''));
                  if (problem === 'bad-request' || problem === 'no-match') setProblem(null);
                }}
              />
            </label>
            <p className="ci-help" id="ci-help">
              The number you registered with. It’s only used to find your name — nothing is saved on this phone.
            </p>
            {t && (
              <div className="ci-problem" role="alert">
                <strong>{t.title}</strong> {t.body}
              </div>
            )}
            <button className="btn accent block ci-btn" disabled={busy || !!wait || !phone.trim()}>
              {busy ? 'Checking…' : wait ? `Try again in ${wait} s` : 'Check me in'}
            </button>
          </form>
        ) : (
          <>
            <div className="ci-problem" role="status">
              <strong>{problemText('closed').title}</strong> {problemText('closed').body}
            </div>
            <button className="btn block ci-btn" onClick={() => void fetchInfo()}>
              Check again
            </button>
          </>
        )}
      </main>
    </div>
  );
}
