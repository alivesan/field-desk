import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Confetti } from '../components/Confetti.tsx';
import { roundName } from '../lib/bracket.ts';
import { reducedMotion } from '../lib/day-fx.ts';
import { roundInPlay, roundShort, wireTone, type WireTone } from '../lib/day-ui.ts';
import { agoText, feederMatch, followPath, matchLabel, readPublicBracket, upNextIds, type PublicBracketView, type PublicMatch } from '../lib/publicBracket.ts';
import { cx, fmtDate } from '../lib/util.ts';
import '../styles/day.css';
import '../styles/public-bracket.css';

/*
 * The live bracket (/b/<token>) — what anyone at the venue, or a player at home, opens from HQ's link or
 * QR: one store's bracket, full screen, no sign-in. Talks only to /api/public/bracket/:token and must not
 * import db.ts (no sync engine, nothing kept on the device but the Fit switch). Phone first; on a TV, Fit
 * scales the whole bracket to the screen. It polls while the page is visible.
 */

type Load = { kind: 'loading' } | { kind: 'ready'; view: PublicBracketView } | { kind: 'gone' } | { kind: 'offline' };

const POLL_MS = 15000;
const TIMEOUT_MS = 15000;
const FIT_KEY = 'fd.bracketFit';
const FIT_MAX = 2.5; // a small bracket on a big TV grows, but not past this
const WIDE = '(min-width: 900px)';

interface Wire {
  key: string;
  from: string; // match ids
  to: string;
  d: string;
  tone: WireTone;
}
const WIRE_RANK: Record<WireTone, number> = { rule: 0, ink: 1, live: 2 };

/** True while the media query matches (the Fit switch only exists on a big screen). */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    mq.addEventListener('change', change);
    change();
    return () => mq.removeEventListener('change', change);
  }, [query]);
  return on;
}

/** "Updated 12 s ago", counting up on its own so the page behind it doesn't re-render every second. */
function Freshness({ at, stale }: { at: number; stale: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="pb-fresh" role="status">
      {at > 0 && `Updated ${agoText(Date.now() - at)}`}
      {stale && <span className="pb-reconnect">{at > 0 ? ' · ' : ''}Reconnecting…</span>}
    </span>
  );
}

export function PublicBracketPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(0);
  const busy = useRef(false);

  const fetchView = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`/api/public/bracket/${encodeURIComponent(token)}`, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      if (res.status === 404 || res.status === 410) return setLoad({ kind: 'gone' });
      const view = res.ok ? readPublicBracket(await res.json().catch(() => null)) : null;
      if (!view) throw new Error('unreadable');
      setStale(false);
      setFetchedAt(Date.now());
      // The same answer again keeps the same object, so the chart isn't redrawn for nothing.
      setLoad((prev) => (prev.kind === 'ready' && JSON.stringify(prev.view) === JSON.stringify(view) ? prev : { kind: 'ready', view }));
    } catch {
      // Keep what is on screen: a phone going through a tunnel shouldn't blank the bracket.
      setStale(true);
      setLoad((prev) => (prev.kind === 'loading' ? { kind: 'offline' } : prev));
    } finally {
      clearTimeout(t);
      busy.current = false;
    }
  }, [token]);

  // Every 15 s while the page is visible; coming back to it looks at once.
  useEffect(() => {
    let timer = 0;
    const stop = () => clearInterval(timer);
    const start = () => {
      stop();
      timer = window.setInterval(() => void fetchView(), POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void fetchView();
        start();
      } else stop();
    };
    void fetchView();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchView]);

  const view = load.kind === 'ready' ? load.view : null;
  useEffect(() => {
    document.title = view?.store ? `${view.store} · Live bracket` : 'Live bracket';
  }, [view?.store]);
  useEffect(() => {
    // A link meant for the people at the event: keep it out of search results.
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => void m.remove();
  }, []);

  if (load.kind === 'gone')
    return (
      <div className="pb pb-plain">
        <main className="pb-plain-inner">
          <div className="pb-kicker">Live bracket</div>
          <h1>This bracket isn’t public right now.</h1>
          <p className="pb-deck">The link may have been turned off or replaced. Ask at the venue desk for the current one.</p>
        </main>
      </div>
    );
  if (load.kind === 'loading' || load.kind === 'offline')
    return (
      <div className="pb pb-plain">
        <main className="pb-plain-inner" aria-busy={load.kind === 'loading'}>
          <div className="pb-kicker">Live bracket</div>
          {load.kind === 'loading' ? (
            <p className="pb-wait">Loading the bracket…</p>
          ) : (
            <>
              <h1>Couldn’t load the bracket.</h1>
              <p className="pb-deck">Check your connection. This page tries again by itself.</p>
              <button className="btn block" onClick={() => void fetchView()}>
                Try again
              </button>
            </>
          )}
        </main>
      </div>
    );
  return <Bracket view={load.view} fetchedAt={fetchedAt} stale={stale} />;
}

function Bracket({ view, fetchedAt, stale }: { view: PublicBracketView; fetchedAt: number; stale: boolean }) {
  const { matches, rounds: total } = view;
  const columns = Array.from({ length: total }, (_, r) => matches.filter((m) => m.round === r).sort((a, b) => a.index - b.index));
  const wide = useMedia(WIDE);
  const [fitPref, setFitPref] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(FIT_KEY);
      return v === null ? null : v === '1';
    } catch {
      return null;
    }
  });
  // Nobody has chosen yet: a big screen (a TV) starts fitted, a phone scrolls.
  const fitting = wide && (fitPref ?? (typeof matchMedia === 'function' && matchMedia('(min-width: 1100px)').matches));
  const setFit = (on: boolean) => {
    setFitPref(on);
    try {
      localStorage.setItem(FIT_KEY, on ? '1' : '0');
    } catch {
      /* private mode — the choice just isn't remembered */
    }
  };

  const [follow, setFollow] = useState<number | null>(null);
  const [active, setActive] = useState(() => roundInPlay(matches));
  const scroller = useRef<HTMLDivElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  const frame = useRef(0);

  // Which round is at the left edge: the lit chip. Throttled to a frame; the last round counts once the chart is scrolled to its end.
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const sc = scroller.current;
      const cols = chart.current?.querySelectorAll<HTMLElement>('.pb-round');
      if (!sc || !cols?.length) return;
      if (sc.scrollWidth > sc.clientWidth && sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2) return setActive(cols.length - 1);
      let best = 0;
      cols.forEach((c, i) => {
        if (Math.abs(c.offsetLeft - sc.scrollLeft) < Math.abs(cols[best].offsetLeft - sc.scrollLeft)) best = i;
      });
      setActive(best);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const toRound = (r: number, smooth = true) => {
    const col = chart.current?.querySelectorAll<HTMLElement>('.pb-round')[r];
    scroller.current?.scrollTo({ left: col?.offsetLeft ?? 0, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
    setActive(r);
  };
  // Opening on a phone: start at the round being played, not at round 1.
  useEffect(() => {
    const r = roundInPlay(matches);
    if (r > 0 && !fitting) toRound(r, false);
  }, []);

  // Fit: the chart keeps its natural size and is scaled to the scroller; its box takes the scaled size so nothing scrolls.
  const [box, setBox] = useState({ scale: 1, w: 0, h: 0 });
  const measureFit = useCallback(() => {
    const sc = scroller.current;
    const ch = chart.current;
    if (!fitting || !sc || !ch) return setBox((p) => (p.scale === 1 && p.w === 0 ? p : { scale: 1, w: 0, h: 0 }));
    const [w, h] = [ch.offsetWidth, ch.offsetHeight];
    if (!w || !h) return;
    const pad = getComputedStyle(sc);
    const room = { w: sc.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight), h: sc.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom) };
    const scale = Math.max(0.2, Math.min(FIT_MAX, room.w / w, room.h / h));
    setBox((p) => (p.scale === scale && p.w === w && p.h === h ? p : { scale, w, h }));
  }, [fitting]);

  // Connector lines: an SVG laid over the chart, drawn from where the cards are (heights vary). offset* ignores the Fit scale.
  const [wires, setWires] = useState<{ w: number; h: number; list: Wire[] }>({ w: 0, h: 0, list: [] });
  const measure = useCallback(() => {
    const el = chart.current;
    if (!el) return;
    const at = new Map<string, { l: number; r: number; y: number }>();
    el.querySelectorAll<HTMLElement>('[data-mid]').forEach((n) => at.set(n.dataset.mid!, { l: n.offsetLeft, r: n.offsetLeft + n.offsetWidth, y: n.offsetTop + n.offsetHeight / 2 }));
    const list: Wire[] = [];
    for (const m of matches) {
      const to = at.get(m.id);
      if (!to) continue;
      for (const side of [0, 1] as const) {
        const f = feederMatch(m, side, matches);
        const from = f && at.get(f.id);
        if (!f || !from) continue;
        const mid = Math.round(from.r + (to.l - from.r) / 2);
        list.push({ key: `${f.id}>${m.id}`, from: f.id, to: m.id, d: `M${Math.round(from.r)} ${Math.round(from.y)}H${mid}V${Math.round(to.y)}H${Math.round(to.l)}`, tone: wireTone(f) });
      }
    }
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    setWires((prev) => (prev.w === w && prev.h === h && prev.list.length === list.length && prev.list.every((x, i) => x.d === list[i].d && x.tone === list[i].tone) ? prev : { w, h, list }));
  }, [matches]);
  useLayoutEffect(() => {
    measure();
    measureFit();
  }, [measure, measureFit]);
  useEffect(() => {
    const [ch, sc] = [chart.current, scroller.current];
    if (!ch || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => (measure(), measureFit()));
    ro.observe(ch);
    if (sc) ro.observe(sc);
    void document.fonts?.ready.then(() => (measure(), measureFit()));
    return () => ro.disconnect();
  }, [measure, measureFit]);

  // Following a player: their matches stay lit, everything else steps back.
  const followed = follow !== null && matches.some((m) => m.aSeed === follow || m.bSeed === follow) ? follow : null;
  const onPath = followed !== null ? followPath(matches, followed) : new Set<string>();
  const mine = followed !== null ? matches.filter((m) => m.aSeed === followed || m.bSeed === followed).sort((x, y) => x.round - y.round) : [];
  const followedName = mine[0] ? (mine[0].aSeed === followed ? mine[0].a : mine[0].b) : null;
  const nextOfMine = mine.find((m) => m.status !== 'done');
  const lastOfMine = mine[mine.length - 1];
  const lastWon = lastOfMine && (lastOfMine.aSeed === followed ? lastOfMine.winner === 'a' : lastOfMine.winner === 'b');

  const upNext = upNextIds(matches);
  const final = matches.find((m) => m.round === total - 1 && m.index === 0);
  const runnerUp = view.champion && final?.status === 'done' ? (final.winner === 'a' ? final.b : final.a) : null;
  const isOn = (w: Wire) => onPath.has(w.from) && onPath.has(w.to);
  const wireList = [...wires.list].sort((x, y) => Number(isOn(x)) - Number(isOn(y)) || WIRE_RANK[x.tone] - WIRE_RANK[y.tone]);

  // Cheer once when a champion is on the screen (Confetti draws nothing under reduced motion).
  const [cheer, setCheer] = useState(0);
  useEffect(() => {
    if (view.champion) setCheer((c) => c + 1);
  }, [!!view.champion]);

  const slot = (m: PublicMatch, side: 0 | 1) => {
    const [name, ign, seed, key] = side === 0 ? [m.a, m.aIgn, m.aSeed, 'a'] : [m.b, m.bIgn, m.bSeed, 'b'];
    if (name === null) {
      const f = feederMatch(m, side, matches);
      return <span className="pb-slot empty">{m.bye && m.round === 0 ? 'Bye' : f ? `Winner of ${matchLabel(f)}` : m.round === 0 ? '—' : 'To be decided'}</span>;
    }
    const lit = seed !== null && seed === followed;
    const won = m.status === 'done' && !m.bye && m.winner === key;
    const lost = m.status === 'done' && !m.bye && m.winner !== null && m.winner !== key;
    return (
      <button
        type="button"
        className={cx('pb-slot', won && 'won', lost && 'lost', lit && 'mine')}
        aria-pressed={lit}
        aria-label={lit ? `Stop following ${name}` : `Follow ${name}’s path`}
        title={lit ? 'Tap to stop following' : 'Tap to follow this player'}
        onClick={() => setFollow(lit || seed === null ? null : seed)}
      >
        <span className="pb-name">
          {name}
          {ign && <small>{ign}</small>}
        </span>
        {won && <span className="pb-won" aria-hidden>Won</span>}
      </button>
    );
  };

  if (!matches.length)
    return (
      <div className="pb">
        <Head view={view} fetchedAt={fetchedAt} stale={stale} />
        <main className="pb-plain-inner">
          <h2 className="pb-empty">The bracket isn’t out yet.</h2>
          <p className="pb-deck">It appears here as soon as the draw is made. This page refreshes by itself.</p>
        </main>
      </div>
    );

  return (
    <div className="pb">
      <Head view={view} fetchedAt={fetchedAt} stale={stale} fit={wide ? { on: fitting, set: setFit } : undefined} />

      {view.champion && (
        <section className="pb-champ" aria-label="Champion">
          <span className="label">Champion</span>
          <h2>{view.champion}</h2>
          {runnerUp && <p>Runner-up · {runnerUp}</p>}
        </section>
      )}

      <div className="pb-nav">
        {!fitting && (
          <div className="pb-pick" role="group" aria-label="Jump to a round">
            {columns.map((list, r) => {
              const live = list.some((m) => m.status === 'live');
              const done = list.every((m) => m.status === 'done');
              return (
                <button key={r} type="button" className={cx('pb-chip', active === r && 'on', live && 'live', done && 'done')} aria-current={active === r ? 'true' : undefined} title={`Go to ${roundName(r, total)}`} onClick={() => toRound(r)}>
                  {live && <i className="pb-dot fd-pulse" aria-hidden />}
                  {done && <span aria-hidden>✓</span>}
                  {roundShort(r, total)}
                  {(live || done) && <span className="sr-only">{live ? ', a match is live' : ', all done'}</span>}
                </button>
              );
            })}
          </div>
        )}
        {followed !== null && followedName && (
          <div className="pb-follow" role="status">
            <span>
              Following <strong>{followedName}</strong>
              <span className="label">
                {nextOfMine ? ` · next ${matchLabel(nextOfMine)}, ${roundName(nextOfMine.round, total)}` : lastWon ? ' · champion' : lastOfMine ? ` · out in ${roundName(lastOfMine.round, total)}` : ''}
              </span>
            </span>
            <span className="pb-follow-actions">
              {nextOfMine && !fitting && (
                <button type="button" className="link" onClick={() => toRound(nextOfMine.round)}>
                  Go there
                </button>
              )}
              <button type="button" className="link" onClick={() => setFollow(null)}>
                Clear
              </button>
            </span>
          </div>
        )}
      </div>

      <div className={cx('pb-scroll', fitting && 'fit', followed !== null && 'following')} ref={scroller} onScroll={onScroll}>
        <div className="pb-stage" style={fitting && box.w ? { width: box.w * box.scale, height: box.h * box.scale } : undefined}>
          <div className="pb-chart" ref={chart} style={{ ['--rounds' as string]: total, ...(fitting && box.w ? { transform: `scale(${box.scale})` } : {}) }}>
            <svg className="pb-wires" width={wires.w} height={wires.h} aria-hidden>
              {wireList.map((w) => (
                <path key={w.key} d={w.d} className={cx('pb-wire', w.tone, followed !== null && (isOn(w) ? 'on' : 'dim'))} />
              ))}
            </svg>
            {columns.map((list, r) => (
              <div key={r} className="pb-round">
                <div className="pb-round-head">
                  <span className="label">{roundName(r, total)}</span>
                  <span className="label">{list.every((m) => m.status === 'done') ? 'all done' : `${list.filter((m) => m.status === 'done').length}/${list.length} done`}</span>
                </div>
                <div className="pb-round-list">
                  {list.map((m) => {
                    const next = upNext.has(m.id);
                    return (
                      <div key={m.id} data-mid={m.id} className={cx('pb-card', m.status, m.bye && 'bye', next && 'next', onPath.has(m.id) && 'onpath')}>
                        <div className="pb-card-top">
                          <span className="pb-no">{matchLabel(m)}</span>
                          {m.score && <span className="pb-score">{m.score}</span>}
                          {m.walkover && <span className="pb-wo">W/O</span>}
                          {m.status === 'live' ? (
                            <span className="pb-tag live">
                              <i className="pb-dot fd-pulse" aria-hidden />
                              Live{m.station ? ` · Station ${m.station}` : ''}
                            </span>
                          ) : m.bye ? (
                            <span className="pb-tag">Bye</span>
                          ) : next ? (
                            <span className="pb-tag next">Up next</span>
                          ) : null}
                        </div>
                        {slot(m, 0)}
                        {slot(m, 1)}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {!fitting && total > 1 && <p className="pb-hint label">Swipe sideways for later rounds, or jump with the round buttons. Tap a name to follow that player.</p>}
      <Confetti run={cheer} />
    </div>
  );
}

function Head({ view, fetchedAt, stale, fit }: { view: PublicBracketView; fetchedAt: number; stale: boolean; fit?: { on: boolean; set: (on: boolean) => void } }) {
  const crowned = !!view.champion;
  const kicker = [view.campaign, view.game, view.date && fmtDate(view.date, { weekday: 'short', day: 'numeric', month: 'short' })].filter(Boolean).join(' · ');
  return (
    <header className="pb-head">
      <div className="pb-title">
        {kicker && <div className="pb-kicker">{kicker}</div>}
        <h1>{view.store}</h1>
        {view.city && <span className="label">{view.city}</span>}
      </div>
      <div className="pb-status">
        <span className={cx('pb-live', crowned && 'over')}>
          <i className={cx('pb-dot', !crowned && 'fd-pulse')} aria-hidden />
          {crowned ? 'Final result' : 'Live'}
        </span>
        <Freshness at={fetchedAt} stale={stale} />
        {fit && (
          <button type="button" className={cx('pb-fit', fit.on && 'on')} aria-pressed={fit.on} title="Scale the whole bracket to the screen" onClick={() => fit.set(!fit.on)}>
            Fit
          </button>
        )}
      </div>
    </header>
  );
}
