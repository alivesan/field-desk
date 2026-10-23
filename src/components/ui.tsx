import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { YesNo } from '../lib/types.ts';
import { login, SIGNED_OUT_KEY, useSync } from '../lib/db.ts';
import { cx } from '../lib/util.ts';
import { SyncStatus } from './SyncStatus.tsx';

/**
 * What a signed-out visitor sees — and all they see. "/" is the field admins' door
 * (4-character code only); HQ signs in at "/hq". Neither reveals anything behind it.
 */
export function AccessGate() {
  const sync = useSync();
  const hq = location.pathname.replace(/\/$/, '') === '/hq';
  const [code, setCode] = useState('');
  const [error, setError] = useState(sync.error ?? '');
  const [busy, setBusy] = useState(false);
  const [signedOut] = useState(() => {
    try {
      return !!sessionStorage.getItem(SIGNED_OUT_KEY);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.removeItem(SIGNED_OUT_KEY); // show it once
    } catch {
      /* ignore */
    }
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const err = await login(code.trim());
    setError(err ?? '');
    setBusy(false);
    if (!err && hq) history.replaceState(null, '', '/' + location.hash);
  };
  return (
    <div className="gate">
      <form onSubmit={submit}>
        <div className="mast-mark">Field Desk</div>
        {signedOut && <p className="gate-note">You’re signed out on this device.</p>}
        <h1>{hq ? 'HQ sign-in.' : 'Open your link from HQ.'}</h1>
        <p className="deck">{hq ? 'For the super admin only.' : 'Your personal link signs you in. Or type the 4-character code from it.'}</p>
        <label className="field">
          <span className="label">{hq ? 'HQ code' : 'Your code'}</span>
          {hq ? (
            <input autoFocus type="password" autoComplete="current-password" value={code} onChange={(e) => setCode(e.target.value)} />
          ) : (
            <input
              autoFocus
              className="code-input"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={4}
              placeholder="····"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            />
          )}
        </label>
        {error && <p className="hint warn">{error}</p>}
        <button className="btn accent block" disabled={(hq ? !code.trim() : code.length !== 4) || busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}

export function Shell({ crumbs = [], children, wide }: { crumbs?: { label: string; href?: string }[]; children: ReactNode; wide?: boolean }) {
  const { role } = useSync();
  return (
    <div className="shell">
      <header className="mast">
        <div className={cx('mast-inner', wide && 'wide')}>
          <a href="#/" className="mast-mark">
            Field Desk
          </a>
          <nav className="crumbs">
            {crumbs.map((c, i) =>
              c.href ? (
                <a key={i} href={c.href}>
                  {c.label}
                </a>
              ) : (
                <span key={i}>{c.label}</span>
              ),
            )}
          </nav>
          {role === 'super' && (
            <>
              <a href="#/winners" className="mast-link">
                Winners
              </a>
              <a href="#/team" className="mast-link">
                Team
              </a>
            </>
          )}
          <SyncStatus />
        </div>
      </header>
      <main className={cx('page', wide && 'wide')}>{children}</main>
    </div>
  );
}

export function PageHead({ kicker, title, deck, children }: { kicker?: ReactNode; title: ReactNode; deck?: ReactNode; children?: ReactNode }) {
  return (
    <div className="phead">
      {kicker && <div className="kicker">{kicker}</div>}
      <h1>{title}</h1>
      {deck && <p className="deck">{deck}</p>}
      {children}
    </div>
  );
}

export const Label = ({ children }: { children: ReactNode }) => <div className="label">{children}</div>;

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  multiline,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
  inputMode?: 'numeric' | 'decimal' | 'text';
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {multiline ? (
        <textarea value={value} placeholder={placeholder} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type={type} value={value} placeholder={placeholder} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

export function NumberField({ label, value, onChange, min = 0, max = 99 }: { label: string; value: number | null; onChange: (v: number | null) => void; min?: number; max?: number }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="stepper">
        <button type="button" onClick={() => set((value ?? 0) - 1)} aria-label="Decrease">
          −
        </button>
        <input
          inputMode="numeric"
          value={value ?? ''}
          placeholder="—"
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange(Number.isNaN(n) ? null : Math.min(max, Math.max(min, n)));
          }}
        />
        <button type="button" onClick={() => set((value ?? 0) + 1)} aria-label="Increase">
          +
        </button>
      </div>
    </div>
  );
}

export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'on')} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const YesNoField = ({ label, value, onChange }: { label: string; value: YesNo; onChange: (v: YesNo) => void }) => (
  <Choice
    label={label}
    value={value}
    onChange={onChange}
    options={[
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ]}
  />
);

export function Check({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={cx('check', checked && 'on')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="box" aria-hidden />
      <span className="check-text">
        {children}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Progress({ value, tone }: { value: number; tone?: 'ok' | 'warn' }) {
  return (
    <div className={cx('progress', tone)}>
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export const Chip = ({ tone, children }: { tone?: 'ok' | 'warn' | 'accent' | 'muted'; children: ReactNode }) => <span className={cx('chip', tone)}>{children}</span>;

/** Re-render on an interval — for "waiting 12 min" style labels. */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function NotFound() {
  return (
    <Shell>
      <PageHead kicker="404" title="Nothing here." deck={<a href="#/">Back to all events</a>} />
    </Shell>
  );
}

/* ---------- confirm / notice (instead of window.confirm and alert) ---------- */

/*
 * Some browsers (embedded ones, or after "don't show again") block window.confirm() / alert()
 * or answer them at once — so "Remove all", "Reset bracket" or replacing a roster did nothing.
 * Every "are you sure?" and every notice goes through these instead: an in-page dialog, mounted
 * once by <ConfirmHost /> next to the app.
 */
interface Asking {
  message: string;
  ok: string;
  cancel: boolean; // false = a notice: one button
  danger: boolean;
  done: (yes: boolean) => void;
}
let asking: Asking | null = null;
const askListeners = new Set<() => void>();
const askChanged = () => askListeners.forEach((f) => f());
const askSubscribe = (f: () => void) => (askListeners.add(f), () => void askListeners.delete(f));

function openAsk(next: Asking) {
  const before = asking;
  asking = next;
  askChanged();
  before?.done(false); // a second question replaces the first, which counts as "no"
}
function settle(yes: boolean) {
  const a = asking;
  asking = null;
  askChanged();
  a?.done(yes);
}

/** "Remove all 12 players?" → true for the OK button, false for Cancel / Esc / a click outside. */
export function askConfirm(message: string, opts: { ok?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) => openAsk({ message, ok: opts.ok ?? 'OK', cancel: true, danger: !!opts.danger, done: resolve }));
}

/** A message with one button (what alert() was for). */
export function notify(message: string) {
  return new Promise<void>((resolve) => openAsk({ message, ok: 'OK', cancel: false, danger: false, done: () => resolve() }));
}

export function ConfirmHost() {
  const a = useSyncExternalStore(askSubscribe, () => asking);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (a && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!a && d.open) d.close();
    // The safe choice has the focus: Cancel for something destructive, else OK.
    if (a) d.querySelector<HTMLButtonElement>('[data-focus]')?.focus();
  }, [a]);
  return (
    <dialog
      ref={ref}
      className="ask"
      aria-label={a?.cancel ? 'Confirm' : 'Notice'}
      onCancel={(e) => {
        e.preventDefault();
        settle(false);
      }}
      onClick={(e) => e.target === e.currentTarget && settle(false)}
    >
      {a && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            settle(true);
          }}
        >
          <p className="ask-text">{a.message}</p>
          <div className="row end">
            {a.cancel && (
              <button type="button" className="btn ghost" data-focus={a.danger || undefined} onClick={() => settle(false)}>
                Cancel
              </button>
            )}
            <button className={cx('btn', a.danger ? 'danger' : 'accent')} data-focus={!a.danger || undefined}>
              {a.ok}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
