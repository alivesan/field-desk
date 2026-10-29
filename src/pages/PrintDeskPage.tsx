import { useEffect, useState } from 'react';
import { PrintFileCard, type PrintItem } from '../components/PrintCards.tsx';
import { Chip, Skeleton } from '../components/ui.tsx';
import { PRINT_KINDS } from '../lib/print.ts';
import { sharedPrefix, storeShortName } from '../lib/names.ts';
import { driveView } from '../lib/printShare.ts';
import type { PrintKind } from '../lib/types.ts';
import { fmtDate } from '../lib/util.ts';
import '../styles/print.css';

/*
 * The print desk (/p/<token>) — whoever prints for the week opens one link, no sign-in, and gets every
 * store's files with the right names. Talks only to /api/public/print/:token…; must not import db.ts
 * (no sync engine, nothing kept on the device). Phone first.
 */

interface DeskFile {
  kind: PrintKind;
  label: string;
  size: string;
  qty: number;
  driveId: string;
}
interface DeskStore {
  id: string;
  name: string;
  city: string;
  date: string;
  files: DeskFile[];
  downloaded: PrintKind[];
}
interface Desk {
  campaign: { id: string; name: string };
  stores: DeskStore[];
}
type Load = { kind: 'loading' } | { kind: 'ready'; desk: Desk } | { kind: 'gone' } | { kind: 'offline' };

const TIMEOUT_MS = 20000;

/** Reads the answer defensively: a proxy's error page or an older server must not blank the screen. */
function readDesk(body: unknown): Desk | null {
  const b = body as { campaign?: { id?: unknown; name?: unknown }; stores?: unknown } | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.stores)) return null;
  const stores: DeskStore[] = [];
  for (const s of b.stores as Record<string, unknown>[]) {
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') continue;
    const files = (Array.isArray(s.files) ? (s.files as Record<string, unknown>[]) : [])
      .filter((f) => f && PRINT_KINDS.includes(f.kind as PrintKind) && typeof f.driveId === 'string')
      .map((f) => ({ kind: f.kind as PrintKind, label: String(f.label ?? ''), size: String(f.size ?? ''), qty: Number(f.qty) || 1, driveId: f.driveId as string }))
      .sort((a, c) => PRINT_KINDS.indexOf(a.kind) - PRINT_KINDS.indexOf(c.kind));
    stores.push({ id: s.id, name: s.name, city: typeof s.city === 'string' ? s.city : '', date: typeof s.date === 'string' ? s.date : '', files, downloaded: Array.isArray(s.downloaded) ? (s.downloaded as PrintKind[]) : [] });
  }
  return { campaign: { id: String(b.campaign?.id ?? ''), name: String(b.campaign?.name ?? '') }, stores };
}

export function PrintDeskPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const base = `/api/public/print/${encodeURIComponent(token)}`;

  const fetchDesk = async (quiet = false) => {
    if (!quiet) setLoad({ kind: 'loading' });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(base, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      if (res.status === 404 || res.status === 410) return setLoad({ kind: 'gone' });
      const desk = res.ok ? readDesk(await res.json().catch(() => null)) : null;
      if (desk) setLoad({ kind: 'ready', desk });
      else if (!quiet) setLoad({ kind: 'offline' });
    } catch {
      if (!quiet) setLoad({ kind: 'offline' });
    } finally {
      clearTimeout(t);
    }
  };

  useEffect(() => {
    void fetchDesk();
    // Coming back to the tab (after printing, say) picks up files HQ replaced in the meantime.
    const back = () => document.visibilityState === 'visible' && void fetchDesk(true);
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [token]);

  const desk = load.kind === 'ready' ? load.desk : null;
  useEffect(() => {
    document.title = desk?.campaign.name ? `Print files · ${desk.campaign.name}` : 'Print files';
  }, [desk?.campaign.name]);
  useEffect(() => {
    // A private working link: keep it out of search results.
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => void m.remove();
  }, []);

  const head = <div className="pd-kicker">{desk?.campaign.name ? `Print desk · ${desk.campaign.name}` : 'Print desk'}</div>;

  if (load.kind === 'loading')
    return (
      <div className="pd">
        <main className="pd-inner" aria-busy="true">
          {head}
          <span className="sr-only">Loading the print files…</span>
          <Skeleton w="min(380px, 80%)" h={46} className="sk-title" />
          <div className="pd-skel">
            <Skeleton h={120} />
            <Skeleton h={120} />
          </div>
        </main>
      </div>
    );

  if (load.kind === 'gone' || load.kind === 'offline')
    return (
      <div className="pd">
        <main className="pd-inner">
          {head}
          <h1>{load.kind === 'gone' ? 'This link isn’t valid any more.' : 'Couldn’t load the files.'}</h1>
          <p className="pd-deck">
            {load.kind === 'gone'
              ? 'It was turned off, or replaced by a new one. Ask HQ for the current print desk link.'
              : 'Check the phone’s connection and try again. Nothing has been lost.'}
          </p>
          {load.kind === 'offline' && (
            <button className="btn block pd-btn" onClick={() => void fetchDesk()}>
              Try again
            </button>
          )}
        </main>
      </div>
    );

  const stores = desk!.stores;
  const names = stores.map((s) => s.name);
  const shared = sharedPrefix(names);
  const fileCount = stores.reduce((n, s) => n + s.files.length, 0);
  const dates = [...new Set(stores.map((s) => s.date))];
  const dayLabel = (d: string) => (d ? fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date');

  return (
    <div className="pd">
      <main className="pd-inner">
        {head}
        <h1>This week’s print files.</h1>
        {stores.length ? (
          <>
            <p className="pd-deck">
              {stores.length} {stores.length === 1 ? 'store' : 'stores'} · {fileCount} files{shared ? ` · ${shared}` : ''}. Every file is saved with the store’s name, ready to print at the size and copies shown.
            </p>
            <div className="pd-top">
              <a className="btn accent pd-btn" href={`${base}/zip`} download>
                Download everything (zip)
              </a>
              <button className="link" onClick={() => void fetchDesk(true)}>
                Refresh
              </button>
            </div>

            {dates.map((date) => (
              <div key={date} className="pd-day">
                {dates.length > 1 && <h2 className="pd-date label">{dayLabel(date)}</h2>}
                {stores
                  .filter((s) => s.date === date)
                  .map((s) => {
                    const short = storeShortName(s.name, names);
                    const items: PrintItem[] = s.files.map((f) => ({ ...f, link: driveView(f.driveId) }));
                    return (
                      <section key={s.id} className="pd-store" aria-label={short}>
                        <header>
                          <div>
                            <h2>{short}</h2>
                            <span className="label">{[s.city, dates.length === 1 ? dayLabel(s.date) : ''].filter(Boolean).join(' · ')}</span>
                          </div>
                          <div className="pd-store-side">
                            {s.downloaded.length > 0 && <Chip tone={s.downloaded.length >= items.length ? 'ok' : undefined}>Store saved {s.downloaded.length}/{items.length}</Chip>}
                            <a className="link" href={`${base}/zip/${encodeURIComponent(s.id)}`} download>
                              Download all (zip)
                            </a>
                          </div>
                        </header>
                        {items.length ? (
                          <ul className="pf-list slim">
                            {items.map((item) => (
                              <PrintFileCard
                                key={item.kind}
                                item={item}
                                storeName={short}
                                saveHref={`${base}/file/${encodeURIComponent(s.id)}/${item.kind}`}
                                viewHref={`${base}/file/${encodeURIComponent(s.id)}/${item.kind}?inline=1`}
                                variant="slim"
                                saveLabel="Download"
                              />
                            ))}
                          </ul>
                        ) : (
                          <p className="hint">No files for this store yet.</p>
                        )}
                      </section>
                    );
                  })}
              </div>
            ))}
          </>
        ) : (
          <p className="pd-deck">Nothing to print yet — HQ hasn’t added this week’s files. This page checks again whenever you come back to it.</p>
        )}
      </main>
    </div>
  );
}
