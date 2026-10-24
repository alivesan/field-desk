import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Stage } from '../lib/stages.ts';
import { cx } from '../lib/util.ts';
import '../styles/desk.css';

/*
 * Small visual pieces shared by the HQ screens, the admin home and the recce: an animated count,
 * a progress ring, the per-store status timeline, empty states with a tiny mark, a segmented bar
 * and a drawn tick. Everything is decoration over real text, and still reads with motion off.
 */

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up to its value (and from the old value when it changes). Plain when motion is reduced. */
export function CountUp({ value, ms = 650 }: { value: number; ms?: number }) {
  const [shown, setShown] = useState(reduced() ? value : 0);
  const from = useRef(reduced() ? value : 0);
  useEffect(() => {
    // Hidden tabs pause animation frames — show the real number rather than a stuck 0.
    if (reduced() || from.current === value || document.hidden) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      from.current = Math.round(a + (value - a) * (1 - Math.pow(1 - p, 3)));
      setShown(from.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Some browsers stop animation frames for pages that aren't drawn; land on the value anyway.
    const done = setTimeout(() => {
      cancelAnimationFrame(raf);
      from.current = value;
      setShown(value);
    }, ms + 150);
    return () => (cancelAnimationFrame(raf), clearTimeout(done));
  }, [value, ms]);
  return (
    <>
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{value}</span>
    </>
  );
}

/** A progress ring, 0..1, with its percentage (or `children`) in the middle. */
export function Ring({ value, size = 56, children, label }: { value: number; size?: number; children?: ReactNode; label?: string }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={cx('ring', v >= 1 && 'full')} style={{ width: size, height: size }} role="img" aria-label={label ?? `${Math.round(v * 100)} percent`}>
      <svg viewBox="0 0 52 52" aria-hidden>
        <circle className="ring-bg" cx="26" cy="26" r={r} />
        <circle className="ring-fg" cx="26" cy="26" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - v)} transform="rotate(-90 26 26)" />
      </svg>
      <span className="ring-text" aria-hidden>
        {children ?? `${Math.round(v * 100)}%`}
      </span>
    </span>
  );
}

/** A thin labelled bar: "Players 3/5". */
export function MiniBar({ label, n, of }: { label: string; n: number; of: number }) {
  const v = of ? n / of : 0;
  return (
    <span className={cx('minibar', of > 0 && n >= of && 'full')} title={`${label}: ${n} of ${of}`}>
      <span className="minibar-top">
        <span>{label}</span>
        <b>
          {n}/{of}
        </b>
      </span>
      <span className="minibar-track">
        <span style={{ transform: `scaleX(${v})` }} />
      </span>
    </span>
  );
}

/** Recce → Reviewed → Players → Bracket → Live → Winners: a dot per step (done ink, current accent, to-do a rule). */
export function StageTrack({ stages, className }: { stages: Stage[]; className?: string }) {
  const now = stages.find((s) => s.state === 'current');
  return (
    <ol className={cx('track', className)} aria-label={now ? `Next step: ${now.label}` : 'Every step done'}>
      {stages.map((s) => (
        <li key={s.key} className={cx(s.state === 'todo' ? 'later' : s.state, s.live && 'live')} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className={cx('track-dot', s.live && 'fd-pulse')} aria-hidden />
          <span className="track-label">{s.label}</span>
          <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? (s.live ? ' (live now)' : ' (next)') : ' (to do)'}</span>
        </li>
      ))}
    </ol>
  );
}

/** One segment per recce section, filling as sections are completed. */
export function SegBar({ segments }: { segments: { key: string; label: string; done: boolean; current?: boolean; onPick?: () => void }[] }) {
  return (
    <ol className="segbar">
      {segments.map((s) => (
        <li key={s.key} className={cx(s.done && 'done', s.current && 'on')}>
          <button type="button" onClick={s.onPick} aria-label={`${s.label}${s.done ? ', done' : ''}`}>
            <span className="segbar-fill" />
            <span className="segbar-label">{s.label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** A big tick (or a "!" for a problem) that pops in. */
export function BigTick({ tone = 'ok' }: { tone?: 'ok' | 'warn' }) {
  return (
    <span className={cx('bigtick', tone, 'fd-pop')} aria-hidden>
      <svg viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="22" />
        {tone === 'ok' ? <path d="M14 25.5l7 7L34.5 17" /> : <path d="M24 13v14M24 34v1" />}
      </svg>
    </span>
  );
}

/* ---------- empty states ---------- */

export type Mark = 'campaign' | 'inbox' | 'players' | 'bracket' | 'winners' | 'walkin' | 'team' | 'stores';

/** A tiny line drawing in ink with one accent stroke. Decorative. */
export function EmptyMark({ mark }: { mark: Mark }) {
  const g = {
    campaign: (
      <>
        <rect x="8" y="12" width="40" height="34" />
        <path d="M8 22h40M18 8v8M38 8v8" />
        <path className="mk-accent" d="M20 34h16" />
      </>
    ),
    inbox: (
      <>
        <path d="M8 30l6-16h28l6 16v14H8z" />
        <path d="M8 30h14l2 5h8l2-5h14" />
        <path className="mk-accent" d="M28 8v8M24 12l4-4 4 4" />
      </>
    ),
    players: (
      <>
        <circle cx="20" cy="20" r="7" />
        <path d="M6 44c0-8 6-13 14-13s14 5 14 13" />
        <path className="mk-accent" d="M40 14v12M34 20h12" />
      </>
    ),
    bracket: (
      <>
        <path d="M8 12h14v10H8zM8 34h14v10H8z" />
        <path d="M22 17h8v17h-8" />
        <path className="mk-accent" d="M30 26h18" />
      </>
    ),
    winners: (
      <>
        <path d="M18 10h20v14a10 10 0 01-20 0z" />
        <path d="M18 14h-8v4a8 8 0 008 8M38 14h8v4a8 8 0 01-8 8" />
        <path d="M28 34v8M20 46h16" />
        <path className="mk-accent" d="M28 15v8" />
      </>
    ),
    walkin: (
      <>
        <rect x="10" y="8" width="36" height="40" />
        <path d="M18 20h20M18 28h12" />
        <path className="mk-accent" d="M18 38l4 4 8-9" />
      </>
    ),
    team: (
      <>
        <circle cx="18" cy="20" r="6" />
        <circle cx="38" cy="22" r="5" />
        <path d="M6 44c0-7 5-11 12-11s12 4 12 11M32 34c6 0 12 3 12 10" />
        <path className="mk-accent" d="M44 10v8M40 14h8" />
      </>
    ),
    stores: (
      <>
        <path d="M8 20l4-10h32l4 10M10 20v24h36V20" />
        <path d="M22 44V30h12v14" />
        <path className="mk-accent" d="M8 20h40" />
      </>
    ),
  }[mark];
  return (
    <svg className="empty-mark" viewBox="0 0 56 56" aria-hidden>
      {g}
    </svg>
  );
}

/** "Nothing here yet" done properly: a mark, one line in the serif, a hint and the next action. */
export function EmptyCard({ mark, title, hint, children, compact }: { mark: Mark; title: string; hint?: ReactNode; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('empty-card', compact && 'compact')}>
      <EmptyMark mark={mark} />
      <div className="empty-copy">
        <p className="empty-title">{title}</p>
        {hint && <p className="empty-hint">{hint}</p>}
        {children && <div className="empty-actions">{children}</div>}
      </div>
    </div>
  );
}
