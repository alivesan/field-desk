import { useMemo, useState } from 'react';
import type { PrintKind, Store, TournamentEvent } from '../lib/types.ts';
import { update } from '../lib/db.ts';
import { matchPrintBlocks, PRINT_KINDS, thisWeekKits, type PrintMatch, type PrintSheetParse } from '../lib/print.ts';
import { printRow } from '../lib/printRow.ts';
import { storeShortName } from '../lib/names.ts';
import { storeDate } from '../lib/recce.ts';
import { ago, cx, fmtDate } from '../lib/util.ts';
import { askConfirm, Chip, toast, useNow } from './ui.tsx';
import { PrintThumb } from './PrintCards.tsx';
import { printProgress } from './PrintEntry.tsx';
import { PrintDeskLink } from './PrintDeskLink.tsx';
import { PrintSpecs } from './PrintSpecs.tsx';
import '../styles/roster.css';
import '../styles/print.css';

/*
 * HQ: the campaign's print files. HQ gets one Google Sheet a week — a tab per event date, a block per
 * store with five Drive links — and pastes its link once. Refresh reads it (our server does, HQ's
 * browser can't) and shows each block against the store it looks like; HQ fixes the doubtful ones and
 * presses Apply, which gives each store its five files. Nothing is written before Apply. Below: which
 * stores have this week's files and how many they've saved, the print desk's link, and the print
 * instructions. Reading the sheet and matching the blocks lives in src/lib/print.ts.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function linkError(status: number, body: { code?: string; error?: string } | null) {
  switch (body?.code) {
    case 'bad-url':
      return 'That doesn’t look like a Google Sheets link. Paste the whole address, starting with https://.';
    case 'blocked-host':
      return 'Field Desk can only read Google Sheets links here.';
    case 'upstream':
      return `The sheet couldn’t be read${body.error ? ` (${body.error})` : ''}. Check that it’s shared “Anyone with the link”.`;
  }
  if (status === 404) return 'Reading print sheets isn’t available on this server yet.';
  if (status === 401 || status === 403) return 'Only HQ can read the sheet. Sign in as HQ and try again.';
  return body?.error ?? `The server couldn’t read the sheet (HTTP ${status}).`;
}

/** The server's answer, checked enough that a proxy's error page can't crash the preview. */
function readSheet(body: unknown): PrintSheetParse | null {
  const tabs = (body as { tabs?: unknown } | null)?.tabs;
  if (!Array.isArray(tabs)) return null;
  const good = tabs.every((t) => t && typeof t.tab === 'string' && Array.isArray(t.blocks) && t.blocks.every((b: { label?: unknown; files?: unknown; problems?: unknown }) => typeof b?.label === 'string' && Array.isArray(b.files) && Array.isArray(b.problems)));
  return good ? (body as PrintSheetParse) : null;
}

export function PrintImport({ event, stores }: { event: TournamentEvent; stores: Store[] }) {
  const now = useNow(30000);
  const saved = event.printSheet;
  const [url, setUrl] = useState(saved?.url ?? '');
  const [fetching, setFetching] = useState(false);
  const [problem, setProblem] = useState('');
  const [sheet, setSheet] = useState<{ parse: PrintSheetParse; at: string; url: string } | null>(null);
  const [picks, setPicks] = useState<Record<number, string>>({}); // block number → store id, '' = skip
  const [tabsOff, setTabsOff] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState('');
  const [specs, setSpecs] = useState(false);

  const names = stores.map((s) => s.name);
  const short = (s: Store) => storeShortName(s.name, names);
  const byId = new Map(stores.map((s) => [s.id, s]));
  const key = stores.map((s) => `${s.id}|${s.name}|${s.city}|${s.state}|${s.date}`).join('\n');
  const matches = useMemo(() => (sheet ? matchPrintBlocks(sheet.parse, stores, event) : []), [sheet, key, event.id, event.date]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The store a block goes to: HQ's pick, else the match; nothing for a block in a tab HQ switched off. */
  const target = (m: PrintMatch, i: number): string | null => {
    if (tabsOff[m.tab]) return null;
    const p = i in picks ? picks[i] : m.storeId;
    return p && byId.has(p) ? p : null;
  };
  const targets = matches.map(target);
  const uses = new Map<string, number>();
  for (const t of targets) if (t) uses.set(t, (uses.get(t) ?? 0) + 1);
  const clash = [...uses.values()].some((n) => n > 1);
  const apply = matches.flatMap((m, i) => (targets[i] && m.files.length && uses.get(targets[i]!) === 1 ? [{ m, storeId: targets[i]! }] : []));
  const partial = apply.filter((a) => a.m.files.length < PRINT_KINDS.length).length;
  // Blocks in a tab that is in use but have no store (HQ left them, or nothing matched): skipped, and said so.
  const skipped = matches.filter((m, i) => !tabsOff[m.tab] && !targets[i]).length;

  const refresh = async () => {
    const u = url.trim();
    if (!u || fetching) return;
    setProblem('');
    setDone('');
    setFetching(true);
    try {
      const res = await fetch(`/api/print/sheet?url=${encodeURIComponent(u)}&year=${encodeURIComponent(event.date.slice(0, 4))}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (!res.ok) return setProblem(linkError(res.status, body));
      const parse = readSheet(body);
      if (!parse) return setProblem('The server sent back something unexpected. Try again.');
      if (!parse.tabs.length) return setProblem('That sheet has no tabs with print links in it.');
      setSheet({ parse, at: new Date().toISOString(), url: u });
      setPicks({});
      // A tab nobody matches (an old week's) starts switched off; HQ can turn it on.
      const found = matchPrintBlocks(parse, stores, event);
      setTabsOff(Object.fromEntries(parse.tabs.filter((t) => !found.some((m) => m.tab === t.tab && m.storeId)).map((t) => [t.tab, true])));
      // The link is remembered for next time (the "this week" mark stays as it was until Apply).
      if (saved?.url !== u) update((d) => void (d.events[event.id] && (d.events[event.id].printSheet = { ...d.events[event.id].printSheet, url: u })));
    } catch {
      setProblem('Couldn’t reach the Field Desk server. Check the connection and try again.');
    } finally {
      setFetching(false);
    }
  };

  const applyAll = async () => {
    if (!sheet || !apply.length) return;
    const files = apply.reduce((n, a) => n + a.m.files.length, 0);
    const replacing = apply.filter((a) => byId.get(a.storeId)?.print).length;
    const msg =
      `Give ${plural(apply.length, 'store')} their print files (${plural(files, 'file')}).` +
      (replacing ? ` ${plural(replacing, 'store')} already ${replacing === 1 ? 'has' : 'have'} files — they’re replaced.` : '') +
      (partial ? ` ${plural(partial, 'block')} ${partial === 1 ? 'is' : 'are'} missing some files.` : '') +
      (skipped ? ` ${plural(skipped, 'block')} without a store ${skipped === 1 ? 'is' : 'are'} skipped.` : '') +
      ' These become this week’s files.';
    if (!(await askConfirm(msg, { ok: 'Apply' }))) return;
    const at = new Date().toISOString();
    update((d) => {
      for (const { m, storeId } of apply) {
        const s = d.stores[storeId];
        if (!s) continue;
        const old = s.print;
        s.print = { files: m.files.map((f) => ({ ...f })), tab: m.tab, label: m.label, importedAt: at };
        // What a team already saved stays saved only where the file is still the same one.
        if (s.printDownloads) {
          for (const k of Object.keys(s.printDownloads) as PrintKind[]) {
            const same = m.files.some((f) => f.kind === k && old?.files.some((o) => o.kind === k && o.driveId === f.driveId));
            if (!same) delete s.printDownloads[k];
          }
          if (!Object.keys(s.printDownloads).length) delete s.printDownloads;
        }
        s.updatedAt = at;
      }
      const e = d.events[event.id];
      if (e) e.printSheet = { url: sheet.url, importedAt: at };
    });
    const text = `${plural(apply.length, 'store')} got their print files`;
    toast(text);
    setDone(text);
    setSheet(null);
    setPicks({});
  };

  const kits = thisWeekKits(event, stores).sort((a, b) => storeDate(a, event).localeCompare(storeDate(b, event)) || a.name.localeCompare(b.name));
  const without = stores.filter((s) => !kits.includes(s));
  const tabs = sheet?.parse.tabs ?? [];

  return (
    <section className="pi" aria-label="Print files">
      <div className="index-head">
        <div className="index-title">
          <h2>Print files</h2>
          <span className="label">Standee · posters · pamphlets · cheques</span>
        </div>
      </div>

      <div className="card pi-form">
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void refresh();
          }}
        >
          <span className="label">This week’s creatives sheet</span>
          <div className="roster-link">
            <input type="url" inputMode="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" type="submit" disabled={fetching || !url.trim()}>
              {fetching ? 'Reading…' : saved?.url === url.trim() || sheet ? 'Refresh' : 'Read sheet'}
            </button>
          </div>
          <span className="hint">
            One tab per event date, a block per store with its Standee, Poster, Pamphlet and two Cheque links. The sheet and its Drive files must be shared “Anyone with the link”. {saved?.importedAt ? `Last applied ${ago(saved.importedAt, now)}.` : ''} Nothing changes until you Apply.
          </span>
        </form>

        {problem && (
          <p className="roster-problem" role="alert">
            {problem}
          </p>
        )}
        {done && <p className="pi-done">{done}.</p>}

        {sheet && (
          <div className="pi-preview">
            <p className="label">
              {plural(matches.length, 'block')} in {plural(tabs.length, 'tab')} · read {ago(sheet.at, now)}
            </p>
            {tabs.map((t) => {
              const rows = matches.map((m, i) => ({ m, i })).filter((x) => x.m.tab === t.tab);
              const off = !!tabsOff[t.tab];
              return (
                <div key={t.tab} className={cx('pi-tab', off && 'off')}>
                  <div className="pi-tab-head">
                    <h3>{t.tab}</h3>
                    <span className="label">{[t.date && fmtDate(t.date, { weekday: 'short', day: 'numeric', month: 'short' }), plural(rows.length, 'store block')].filter(Boolean).join(' · ')}</span>
                    <label className="pi-use">
                      <input type="checkbox" checked={!off} onChange={(e) => setTabsOff((o) => ({ ...o, [t.tab]: !e.target.checked }))} />
                      Use this tab
                    </label>
                  </div>
                  {!rows.length && <p className="hint">No store blocks found in this tab.</p>}
                  <ul className="pi-blocks">
                    {rows.map(({ m, i }) => (
                      <Block key={i} m={m} chosen={targets[i]} clash={!!targets[i] && (uses.get(targets[i]!) ?? 0) > 1} disabled={off} stores={stores} short={short} onPick={(id) => setPicks((p) => ({ ...p, [i]: id }))} />
                    ))}
                  </ul>
                </div>
              );
            })}
            {clash && <p className="pi-note warn">Two blocks go to the same store. Skip one of them, or pick another store, before applying.</p>}
            <div className="row end roster-actions">
              <button
                className="link"
                onClick={() => {
                  setSheet(null);
                  setPicks({});
                }}
              >
                Clear
              </button>
              <button className="btn" disabled={!apply.length || clash} onClick={() => void applyAll()}>
                {apply.length ? `Apply to ${plural(apply.length, 'store')}` : 'Nothing to apply'}
              </button>
            </div>
          </div>
        )}
      </div>

      {saved?.importedAt && (
        <div className="pi-kits">
          <div className="pi-kits-head">
            <h3>This week’s files</h3>
            <span className="label">
              {kits.length} of {stores.length} {stores.length === 1 ? 'store' : 'stores'} · applied {ago(saved.importedAt, now)}
            </span>
          </div>
          {kits.length > 0 ? (
            <ul className="pi-kit-list">
              {kits.map((s) => {
                const p = printProgress(s);
                return (
                  <li key={s.id} className="pi-kit">
                    <div className="pi-kit-who">
                      <b>{short(s)}</b>
                      <span className="label">{[s.city, fmtDate(storeDate(s, event), { weekday: 'short', day: 'numeric', month: 'short' }), s.print?.tab && `tab ${s.print.tab}`].filter(Boolean).join(' · ')}</span>
                    </div>
                    <ul className="pi-dots" aria-label="Files saved by the store">
                      {PRINT_KINDS.map((k) => {
                        const has = s.print?.files.some((f) => f.kind === k);
                        const d = s.printDownloads?.[k];
                        return (
                          <li key={k} className={cx(d && 'on', !has && 'none')} title={`${printRow(event, k).label}: ${!has ? 'no file' : d ? `saved ${ago(d.at, now)} by ${d.by}` : 'not saved yet'}`}>
                            {kindShort[k]}
                          </li>
                        );
                      })}
                    </ul>
                    <Chip tone={p.saved >= p.ready ? 'ok' : p.saved ? 'warn' : 'muted'}>
                      downloaded {p.saved}/{p.ready}
                    </Chip>
                    <a className="link" href={`#/store/${s.id}/print`}>
                      Open
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="hint">No store has this week’s files — the last Apply covered none of this campaign’s stores.</p>
          )}
          {kits.length > 0 && without.length > 0 && (
            <p className="pi-note warn">
              <b>{plural(without.length, 'store')} without this week’s files:</b> {without.slice(0, 8).map(short).join(', ')}
              {without.length > 8 ? ` and ${without.length - 8} more` : ''}.
            </p>
          )}
        </div>
      )}

      <PrintDeskLink event={event} />

      <div className="pi-specs">
        <button className="link" onClick={() => setSpecs((v) => !v)} aria-expanded={specs}>
          {specs ? 'Hide print instructions' : 'Print instructions (size and copies)'}
        </button>
        {specs && <PrintSpecs event={event} />}
      </div>
    </section>
  );
}

function Block({
  m,
  chosen,
  clash,
  disabled,
  stores,
  short,
  onPick,
}: {
  m: PrintMatch;
  chosen: string | null;
  clash: boolean;
  disabled: boolean;
  stores: Store[];
  short: (s: Store) => string;
  onPick: (storeId: string) => void;
}) {
  const likely = m.candidates.map((id) => stores.find((s) => s.id === id)).filter((s): s is Store => !!s);
  const others = stores.filter((s) => !likely.includes(s)).sort((a, b) => short(a).localeCompare(short(b)));
  const unsure = !m.storeId && likely.length > 1;
  const status = disabled ? { tone: 'muted' as const, label: 'Not used' } : clash ? { tone: 'warn' as const, label: 'Two blocks' } : chosen ? { tone: 'ok' as const, label: m.storeId === chosen ? 'Matched' : 'Chosen' } : { tone: 'warn' as const, label: unsure ? 'Which one?' : 'No match' };
  const files = new Map(m.files.map((f) => [f.kind, f]));
  return (
    <li className={cx('pi-block', disabled && 'off')}>
      <div className="pi-block-head">
        <b className="pi-label" title="As written in the sheet">
          {m.label}
        </b>
        <span className="pi-arrow" aria-hidden>
          →
        </span>
        <select className="pi-pick" aria-label={`Store for “${m.label}”`} value={chosen ?? ''} disabled={disabled} onChange={(e) => onPick(e.target.value)}>
          <option value="">{chosen || disabled ? 'Skip this block' : 'Choose a store, or skip it'}</option>
          {likely.length > 0 && (
            <optgroup label={unsure ? 'Could be' : 'Looks like'}>
              {likely.map((s) => (
                <option key={s.id} value={s.id}>
                  {short(s)}
                  {s.city ? ` · ${s.city}` : ''}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="All stores">
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {short(s)}
                {s.city ? ` · ${s.city}` : ''}
              </option>
            ))}
          </optgroup>
        </select>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>
      <ul className="pi-files">
        {PRINT_KINDS.map((kind) => {
          const f = files.get(kind);
          return (
            <li key={kind} className={cx('pi-file', !f && 'missing')}>
              {f ? <PrintThumb driveId={f.driveId} alt={f.name || kind} href={f.url} width={200} /> : <div className="pf-thumb failed" style={{ aspectRatio: '1' }}><span>Missing</span></div>}
              <span className="pi-kind">{kindShort[kind]}</span>
            </li>
          );
        })}
      </ul>
      {m.problems.length > 0 && (
        <ul className="pi-problems">
          {m.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

const kindShort: Record<PrintKind, string> = { standee: 'Standee', poster: 'Poster', pamphlet: 'Pamphlet', chequeWinner: 'Winner', chequeRunnerUp: 'Runner-up' };
