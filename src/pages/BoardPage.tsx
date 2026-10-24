import { useEffect, useRef, useState } from 'react';
import { useApp, useSync, type SyncInfo } from '../lib/db.ts';
import { computeQueue, matchNo, roundCount, roundName } from '../lib/bracket.ts';
import { NotFound, useNow } from '../components/ui.tsx';
import { cx, fmtTime } from '../lib/util.ts';
import { checkInUrl } from '../lib/checkin.ts';
import { finalResult } from '../lib/winnerInput.ts';
import { CheckInQr } from '../components/CheckInQr.tsx';
import { Confetti, CONFETTI_DARK } from '../components/Confetti.tsx';
import '../styles/day.css';
import { shareOrigin, useLan } from '../lib/origin.ts';
import '../styles/checkin.css';

/** The champion moment repeats now and then while the screen stays up, so whoever walks past still catches it. */
const RECHEER_MS = 30000;

/**
 * Full-screen display for a TV at the venue: who's on, who's next, who still needs to check in —
 * and, while player QR check-in is open, the QR itself.
 */
export function BoardPage({ storeId }: { storeId: string }) {
  const store = useApp((s) => s.stores[storeId]);
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const now = useNow(5000);
  const sync = useSync();
  useLan(); // re-render once the Wi-Fi address is known

  // Confetti when a champion is on the screen: at once, then every half minute. Never with reduced motion (Confetti skips itself).
  const crowned = !!store && !!computeQueue(store.day).champion;
  const nameRef = useRef<HTMLHeadingElement>(null);
  const [cheer, setCheer] = useState(0);
  useEffect(() => {
    if (!crowned) return;
    setCheer((c) => c + 1);
    const t = setInterval(() => setCheer((c) => c + 1), RECHEER_MS);
    return () => clearInterval(t);
  }, [crowned]);
  if (!store || !event) return <NotFound />;

  const day = store.day;
  const q = computeQueue(day);
  const names = Object.fromEntries(day.players.map((p) => [p.id, p.name]));
  const total = roundCount(day.matches);
  const label = (m: (typeof day.matches)[number]) => `M${matchNo(m, day.matches)} · ${roundName(m.round, total)}`;
  const callNext = q.ready.slice(0, 6);
  const needed = [...new Set(q.waiting.flatMap((w) => w.missing))];
  const runnerUp = finalResult(day.matches)?.runnerUp; // names only on this public screen — never the collected contact details
  const qr = day.selfCheckIn?.open ? checkInUrl(shareOrigin(), day.selfCheckIn.token) : null;

  return (
    <div className="board">
      <header className="board-head">
        <div>
          <span className="label">{event.name}</span>
          <h1>{store.name}</h1>
        </div>
        <div className="board-clock">
          <BoardClock />
          <Freshness sync={sync} now={now} />
        </div>
      </header>

      <div className={cx('board-body', qr && 'with-qr')}>
        <div className="board-main">
          {q.champion ? (
            <section className="board-champ">
              <span className="label fd-enter">Champion</span>
              <h2 ref={nameRef} className="board-champ-name">
                {names[q.champion]}
              </h2>
              {runnerUp && names[runnerUp] && (
                <p className="board-runner fd-enter" style={{ ['--fd-delay' as string]: '700ms' }}>
                  Runner-up · {names[runnerUp]}
                </p>
              )}
            </section>
          ) : !day.matches.length ? (
            <section className="board-champ waiting fd-enter">
              <span className="label">Check-in is open</span>
              <h2>Matches start soon.</h2>
            </section>
          ) : (
            <div className="board-grid">
              <section>
                <h3 className="label">Now playing</h3>
                {q.live.length ? (
                  q.live.map((m) => (
                    <div key={m.id} className="board-live fd-enter">
                      <span className="board-stn">{m.station}</span>
                      <div>
                        <span className="label board-livelabel">
                          <i className="board-dot fd-pulse" aria-hidden />
                          Live · {label(m)}
                        </span>
                        <div className="board-pair">
                          {names[m.a!]} <em>vs</em> {names[m.b!]}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="board-empty fd-enter">Stations are free — next match is being called.</p>
                )}
              </section>
              <section>
                <h3 className="label">Up next — be ready</h3>
                {callNext.length ? (
                  <ol className="board-next">
                    {callNext.map(({ match: m }, i) => (
                      <li key={m.id} className="fd-enter">
                        <span className="board-qn">{i + 1}</span>
                        <div>
                          <span className="label">{label(m)}</span>
                          <div className="board-pair small">
                            {names[m.a!]} <em>vs</em> {names[m.b!]}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="board-empty fd-enter">Waiting on results.</p>
                )}
                {needed.length > 0 && (
                  <div className="board-needed fd-enter">
                    <h3 className="label">{qr ? 'Please check in — scan the QR or see the desk' : 'Please check in at the desk'}</h3>
                    <p>{needed.map((id) => names[id]).join(' · ')}</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
        {qr && (
          <aside className="board-qr" aria-label="Player check-in">
            <CheckInQr value={qr} />
            <h2>Scan to check in</h2>
            <p>Type the phone number you registered with — your name comes up and you’re in.</p>
            <p className="board-qr-url">{qr.replace(/^https?:\/\//, '')}</p>
          </aside>
        )}
      </div>
      <Confetti
        run={cheer}
        colors={CONFETTI_DARK}
        count={140}
        duration={1600}
        origin={() => {
          const r = nameRef.current?.getBoundingClientRect();
          return r ? { x: r.left + Math.min(r.width, window.innerWidth * 0.6) / 2, y: Math.min(Math.max(r.top + r.height / 2, 120), window.innerHeight * 0.7) } : null;
        }}
      />
    </div>
  );
}

/** The clock, big, with a colon that breathes. Its own component so a tick re-renders only this. */
function BoardClock() {
  const now = new Date(useNow(1000));
  const parts = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  return (
    <>
      <time className="board-time" dateTime={now.toISOString()}>
        {parts.map((p, i) =>
          p.type === 'literal' && p.value.trim() === ':' ? (
            <span key={i} className="colon" aria-hidden>
              :
            </span>
          ) : p.type === 'dayPeriod' ? (
            <small key={i}>{p.value}</small>
          ) : (
            <span key={i}>{p.value.trim() === '' ? '' : p.value}</span>
          ),
        )}
      </time>
      <span className="board-date">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </>
  );
}

/**
 * How current the board's data is (audit §6.5). The clock above keeps ticking offline, so it
 * says nothing about the data — this line does.
 */
function Freshness({ sync, now }: { sync: SyncInfo; now: number }) {
  const at = sync.lastSyncAt ? new Date(sync.lastSyncAt).getTime() : null;
  const age = at === null ? null : Math.max(0, Math.round((now - at) / 1000));
  const ago = age === null ? '' : age < 60 ? `${age} s ago` : age < 3600 ? `${Math.floor(age / 60)} min ago` : `at ${fmtTime(sync.lastSyncAt!)}`;
  let text: string;
  let stale = true;
  if (sync.status === 'live') {
    stale = false;
    text = at === null ? 'Live' : `Live · updated ${ago}`;
  } else if (sync.status === 'connecting') text = at === null ? 'Connecting…' : `Reconnecting · last update ${ago} — may be out of date`;
  else if (sync.status === 'locked') text = 'Signed out — this board is not updating';
  else text = at === null ? 'Offline — no data from the server yet' : `Offline since ${fmtTime(sync.lastSyncAt!)} — may be out of date`;
  return <span className={cx('board-fresh', stale && 'stale')}>{text}</span>;
}
