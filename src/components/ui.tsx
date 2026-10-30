import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { YesNo } from '../lib/types.ts';
import { askName, login, setMyName, SIGNED_OUT_KEY, useSync } from '../lib/db.ts';
import { cx } from '../lib/util.ts';
import { useRoute } from '../lib/router.ts';
import { SyncStatus } from './SyncStatus.tsx';
import { UpdateBar } from './UpdateBar.tsx';

/**
 * What a signed-out visitor sees — and all they see. "/" is the field team's door (a
 * 4-character code: a person's own, or their store's); HQ signs in at "/hq". Neither reveals anything behind it.
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
        <p className="deck">{hq ? 'For the super admin only.' : 'Open your store’s link, or type its 4-character code.'}</p>
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

/**
 * A store team's code signs a phone in to the store, not to a person — so the first time (and on
 * "Change name") it asks who is holding this phone. The name is kept on the device and goes next
 * to what they do ("Rhea (San Infotech team)"). Shown instead of the app until it's answered.
 */
export function NamePrompt() {
  const { team, name } = useSync();
  const [value, setValue] = useState(name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const err = await setMyName(value);
    setError(err ?? '');
    setBusy(false);
  };
  return (
    <div className="gate">
      <form onSubmit={submit}>
        <div className="mast-mark">Field Desk</div>
        <h1>You’re signed in to {team ?? 'your store'}.</h1>
        <p className="deck">What’s your name? It goes next to what you do here, so HQ can tell who did what.</p>
        <label className="field">
          <span className="label">Your name</span>
          <input autoFocus autoComplete="given-name" autoCapitalize="words" maxLength={40} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {error && <p className="hint warn">{error}</p>}
        <button className="btn accent block" disabled={!value.trim() || busy}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
        {name && (
          <button type="button" className="link" onClick={() => askName(false)}>
            Keep “{name}”
          </button>
        )}
      </form>
    </div>
  );
}

/** From package.json via vite.config.ts `define`; tests that import this file outside Vite get a stand-in. */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export function Shell({ crumbs = [], children, wide }: { crumbs?: { label: string; href?: string }[]; children: ReactNode; wide?: boolean }) {
  const { role, team, name } = useSync();
  return (
    <div className="shell">
      <header className="mast">
        <div className={cx('mast-inner', wide && 'wide')}>
          <a href="#/" className="mast-mark">
            Field Desk
          </a>
          <span className="beta" title={`Field Desk ${APP_VERSION} — beta. Tell HQ what feels off.`}>
            Beta
          </span>
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
              <a href="#/steam" className="mast-link">
                Steam
              </a>
              <a href="#/marketing" className="mast-link">
                Marketing
              </a>
              <a href="#/team" className="mast-link">
                Team
              </a>
            </>
          )}
          <SyncStatus />
        </div>
      </header>
      <UpdateBar />
      <main className={cx('page', wide && 'wide')}>{children}</main>
      <footer className={cx('foot', wide && 'wide')}>
        <span>Field Desk</span>
        <span>{/^\d/.test(APP_VERSION) ? `v${APP_VERSION}` : APP_VERSION}</span>
        <span className="beta-note">beta</span>
        {team && name && (
          <button type="button" className="link foot-who" onClick={() => askName()}>
            {name} · {team} team — change name
          </button>
        )}
      </footer>
    </div>
  );
}

export function PageHead({ kicker, title, deck, children }: { kicker?: ReactNode; title: ReactNode; deck?: ReactNode; children?: ReactNode }) {
  const route = useRoute().join('/'); // a new page (or another store/event) fades in again
  return (
    <div className="phead fd-enter" key={route}>
      {kicker && <div className="kicker">{kicker}</div>}
      <h1>{title}</h1>
      {deck && <p className="deck">{deck}</p>}
      {children}
    </div>
  );
}

/** A placeholder bar while something loads: give it a size, it shimmers. Decorative (aria-hidden). */
export function Skeleton({ w = '100%', h = 14, className }: { w?: number | string; h?: number | string; className?: string }) {
  return <span className={cx('skeleton', 'fd-shimmer', className)} style={{ width: w, height: h }} aria-hidden />;
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

/* ---------- toasts (quiet, non-blocking confirmation) ---------- */

/*
 * For "Saved", "Copied", "Checked in" — things that need no answer. Anything the person must read
 * and acknowledge (a failure, a refusal) stays on notify() / askConfirm(), which block until answered.
 * Up to 3 stack, each leaves by itself after 3 s; <ToastHost /> is mounted once next to <ConfirmHost />.
 */
export type ToastTone = 'ok' | 'warn' | 'accent';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  icon: ReactNode;
  leaving: boolean;
}
const TOAST_MS = 3000;
const TOAST_EXIT_MS = 200;
const TOAST_MAX = 3;
const TOAST_ICON: Record<ToastTone, string> = { ok: '✓', warn: '!', accent: '•' };
let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const toastListeners = new Set<() => void>();
const toastChanged = () => toastListeners.forEach((f) => f());
const toastSubscribe = (f: () => void) => (toastListeners.add(f), () => void toastListeners.delete(f));

function toastEnd(id: number) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  toastChanged();
}
function toastLeave(id: number) {
  clearTimeout(toastTimers.get(id));
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  toastChanged();
  toastTimers.set(id, setTimeout(() => toastEnd(id), TOAST_EXIT_MS));
}

/** A short, self-dismissing message. The same text shown again just restarts its timer. */
export function toast(message: string, opts: { tone?: ToastTone; icon?: ReactNode } = {}) {
  const tone = opts.tone ?? 'ok';
  const icon = opts.icon ?? TOAST_ICON[tone];
  const same = toasts.find((t) => t.message === message && t.tone === tone && !t.leaving);
  if (same) {
    clearTimeout(toastTimers.get(same.id));
    toastTimers.set(same.id, setTimeout(() => toastLeave(same.id), TOAST_MS));
    return;
  }
  const id = ++toastSeq;
  toasts = [...toasts, { id, message, tone, icon, leaving: false }];
  for (const old of toasts.slice(0, Math.max(0, toasts.length - TOAST_MAX))) toastEnd(old.id); // oldest go first
  toastChanged();
  toastTimers.set(id, setTimeout(() => toastLeave(id), TOAST_MS));
}

export function ToastHost() {
  const list = useSyncExternalStore(toastSubscribe, () => toasts);
  const host = useRef<HTMLDivElement>(null);
  // Sheets and confirms are modal <dialog>s in the browser's top layer, above any z-index.
  // A manual popover joins that layer too; re-showing it moves it to the top, so a toast fired
  // from inside a sheet ("Asha R. checked in") is visible above the sheet.
  useEffect(() => {
    const el = host.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el?.showPopover || !list.length) return;
    try {
      if (el.matches(':popover-open')) el.hidePopover?.();
      el.showPopover();
    } catch {
      /* older browsers: the fixed z-index fallback still applies */
    }
  }, [list]);
  return (
    <div ref={host} {...{ popover: 'manual' }} className="toasts" role="status" aria-live="polite" aria-relevant="additions">
      {list.map((t) => (
        <button key={t.id} type="button" className={cx('toast', t.tone, t.leaving && 'leaving')} onClick={() => toastLeave(t.id)}>
          <span className="toast-icon" aria-hidden>
            {t.icon}
          </span>
          <span className="toast-text">{t.message}</span>
        </button>
      ))}
    </div>
  );
}
