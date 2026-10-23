import { useMemo, useState } from 'react';
import type { Admin, Store, TournamentEvent } from '../lib/types.ts';
import { newStore, update } from '../lib/db.ts';
import { decodeText, looksLikeHtml } from '../lib/roster.ts';
import { applySheetFields, COLUMN_LABEL, needsResolve, parseStoreSheet, planStoreSheet, STORE_SHEET_TEMPLATE, type FieldChange, type PlanItem, type PlanStatus, type SheetColumn, type SheetFields } from '../lib/storesheet.ts';
import { ago, cx, fmtDate } from '../lib/util.ts';
import { askConfirm, Chip, useNow } from './ui.tsx';
import { locate } from './StoreForm.tsx';
import '../styles/roster.css';
import '../styles/storesheet.css';

/*
 * HQ: the campaign's stores from a sheet — an uploaded CSV, a published / "anyone with the link"
 * Google Sheet (fetched by our server, remembered on the campaign so next time it is one press on
 * Refresh) or pasted cells. The preview says per row whether it creates a store, changes one
 * (and which fields) or changes nothing; nothing is written until Apply, which is one local edit
 * like any other store edit. Stores that aren't in the sheet are listed and never touched.
 * Parsing and matching live in src/lib/storesheet.ts.
 */

type Source = 'upload' | 'link' | 'paste';

interface Input {
  kind: 'upload' | 'link';
  text: string;
  fileName?: string;
  url?: string;
  fetchedAt: string;
}

const SOURCES: { value: Source; label: string }[] = [
  { value: 'upload', label: 'Upload CSV' },
  { value: 'link', label: 'Sheet link' },
  { value: 'paste', label: 'Paste' },
];

const NOT_SHARED = 'That link opened a web page, not a sheet. In Google Sheets use Share → “Anyone with the link”, or File → Share → Publish to the web (as CSV), then try again.';

function linkError(status: number, body: { code?: string; error?: string } | null) {
  switch (body?.code) {
    case 'bad-url':
      return 'That doesn’t look like a sheet link. Paste the whole address, starting with https://.';
    case 'blocked-host':
      return 'Field Desk can’t fetch from that address. Use a Google Sheets link or a published CSV link.';
    case 'too-large':
      return 'That sheet is too large to import. Keep it to the store list.';
    case 'upstream':
      return `The sheet couldn’t be fetched${body.error ? ` (${body.error})` : ''}. Check it’s shared “Anyone with the link” or published to the web.`;
  }
  if (status === 404) return 'Fetching sheet links isn’t available on this server yet — download the sheet as CSV and upload it instead.';
  if (status === 401 || status === 403) return 'Only HQ can fetch sheet links. Sign in as HQ and try again.';
  return body?.error ?? `The server couldn’t fetch the link (HTTP ${status}).`;
}

const STATUS: Record<PlanStatus, { tone?: 'ok' | 'warn' | 'accent' | 'muted'; label: string }> = {
  create: { tone: 'ok', label: 'New' },
  update: { tone: 'accent', label: 'Changed' },
  unchanged: { tone: 'muted', label: 'Unchanged' },
  error: { tone: 'warn', label: 'Fix the row' },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A change as one line: "City: Pune → Nashik"; links just say they changed. */
function changeText(c: FieldChange) {
  if (c.field === 'mapsUrl' || c.field === 'toornamentUrl') return `${c.label}: ${c.from ? 'link changed' : 'link added'}`;
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
  return `${c.label}: ${c.from ? clip(c.from) : '—'} → ${clip(c.to)}`;
}

/** What a new store will get, in a line. */
function fieldsText(f: SheetFields, eventDate: string, adminName: string | undefined) {
  return [
    [f.city, f.state].filter(Boolean).join(', '),
    f.date && f.date !== eventDate ? fmtDate(f.date, { weekday: 'short', day: 'numeric', month: 'short' }) : '',
    adminName,
    f.mapsUrl ? 'Maps link' : '',
    f.toornamentUrl ? 'Toornament' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function StoreSheetImport({ event, stores, admins, onClose }: { event: TournamentEvent; stores: Store[]; admins: Admin[]; onClose: () => void }) {
  const now = useNow(30000);
  const saved = event.storeSheet;
  const [source, setSource] = useState<Source>(saved ? 'link' : 'upload');
  const [input, setInput] = useState<Input | null>(null);
  const [paste, setPaste] = useState('');
  const [url, setUrl] = useState(saved?.url ?? '');
  const [fetching, setFetching] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const text = source === 'paste' ? paste : input?.kind === source ? input.text : '';
  const year = Number(event.date.slice(0, 4)) || undefined;
  const adminKey = admins.map((a) => `${a.id}|${a.name}`).join('\n');
  const parse = useMemo(
    () => (text.trim() ? parseStoreSheet(text, { admins: admins.map((a) => ({ id: a.id, name: a.name })), year }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, adminKey, year],
  );
  const plan = parse ? planStoreSheet(parse, stores, event, admins) : null;
  const targets = plan ? plan.items.filter((i) => i.status === 'create' || i.status === 'update') : [];
  const adminName = (id: string | undefined) => (id ? admins.find((a) => a.id === id)?.name : undefined);

  const chooseSource = (s: Source) => {
    setSource(s);
    setProblem('');
    setDone('');
  };

  const onFile = async (file: File | undefined) => {
    setProblem('');
    setDone('');
    if (!file) return;
    if (/\.(xlsx|xlsm|xls|ods|numbers)$/i.test(file.name)) {
      setProblem('That’s a spreadsheet file, not a CSV. In Google Sheets use File → Download → CSV; in Excel, Save As → CSV UTF-8. Then upload that.');
      return;
    }
    if (file.size > 2_000_000) {
      setProblem('That file is over 2 MB — upload just the store list as CSV.');
      return;
    }
    try {
      setInput({ kind: 'upload', text: decodeText(new Uint8Array(await file.arrayBuffer())), fileName: file.name, fetchedAt: new Date().toISOString() });
    } catch {
      setProblem('This browser couldn’t read that file. Try saving it again as CSV.');
    }
  };

  const fetchLink = async () => {
    const u = url.trim();
    if (!u) return;
    setProblem('');
    setDone('');
    setFetching(true);
    try {
      const res = await fetch(`/api/roster/fetch?url=${encodeURIComponent(u)}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (!res.ok) setProblem(linkError(res.status, body));
      else if (typeof body?.text !== 'string') setProblem('The server sent back something unexpected. Try again.');
      else if (looksLikeHtml(body.text)) setProblem(NOT_SHARED);
      else setInput({ kind: 'link', text: body.text, url: u, fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt : new Date().toISOString() });
    } catch {
      setProblem('Couldn’t reach the Field Desk server. Check the connection and try again.');
    } finally {
      setFetching(false);
    }
  };

  const clear = () => {
    setInput(null);
    setPaste('');
    setProblem('');
    setDone('');
  };

  /** Short Maps links (maps.app.goo.gl) are expanded by the server, a few at a time. */
  const resolveGeos = async (items: PlanItem[]) => {
    const urls = [...new Set(items.filter(needsResolve).map((i) => i.row.fields.mapsUrl!))];
    const found = new Map<string, Awaited<ReturnType<typeof locate>>>();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, urls.length) }, async () => {
        while (next < urls.length) {
          const u = urls[next++];
          found.set(u, await locate(u));
        }
      }),
    );
    return found;
  };

  const apply = async () => {
    if (!plan || !targets.length || busy) return;
    const { create, update: changed, error } = plan.counts;
    const msg =
      `${[create && `Add ${plural(create, 'new store')}`, changed && `${create ? 'change' : 'Change'} ${plural(changed, 'store')}`].filter(Boolean).join(' and ')}.` +
      (error ? ` ${plural(error, 'row')} with problems will be skipped.` : '') +
      ' Stores that aren’t in the sheet stay as they are, and empty cells change nothing.';
    if (!(await askConfirm(msg, { ok: 'Apply' }))) return;
    setBusy(true);
    try {
      const geos = await resolveGeos(targets);
      const at = new Date().toISOString();
      update((d) => {
        for (const it of targets) {
          const f = it.row.fields;
          const geo = it.row.geo ?? (f.mapsUrl ? (geos.get(f.mapsUrl) ?? null) : null);
          if (it.status === 'create') {
            const s = newStore(event.id, { name: f.name });
            applySheetFields(s, f, geo, d.admins, event.date, at);
            d.stores[s.id] = s;
          } else {
            const s = d.stores[it.store!.id];
            if (s) applySheetFields(s, f, geo, d.admins, event.date, at);
          }
        }
        if (source === 'link' && input?.kind === 'link' && input.url && d.events[event.id]) d.events[event.id].storeSheet = { url: input.url, fetchedAt: input.fetchedAt };
      });
      const noGeo = targets.filter((i) => i.row.fields.mapsUrl && !i.row.geo && !geos.get(i.row.fields.mapsUrl));
      setDone(
        [create && `${plural(create, 'store')} added`, changed && `${plural(changed, 'store')} changed`].filter(Boolean).join(' · ') +
          (noGeo.length ? ` · ${plural(noGeo.length, 'Maps link')} without coordinates (${noGeo.slice(0, 3).map((i) => i.row.fields.name).join(', ')}${noGeo.length > 3 ? '…' : ''})` : ''),
      );
    } finally {
      setBusy(false);
    }
  };

  const cols = parse ? (Object.entries(parse.columns) as [SheetColumn, string][]).map(([k, h]) => (h.trim().toLowerCase() === COLUMN_LABEL[k].toLowerCase() ? h : `${h} → ${COLUMN_LABEL[k]}`)) : [];
  const fresh = source === 'link' && input?.kind === 'link' && input.url === url.trim();

  return (
    <section className="roster-import store-sheet" aria-label="Import stores from a sheet">
      <div className="index-head">
        <h3>Import stores from a sheet</h3>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">
        One row per store. Columns: <b>Store name</b> (required), <b>ROG Exclusive</b> (Yes/No), <b>City</b>, <b>State</b>, <b>Google Maps link</b>, <b>Toornament link</b>, <b>Date</b>, and optionally <b>Address</b>, <b>Phone</b>, <b>Venue spot</b>, <b>Admin</b> (a name from Team). Importing again updates stores by name instead of adding them twice; empty cells and stores that aren’t in the sheet are left alone.{' '}
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${STORE_SHEET_TEMPLATE}`)}`} download="stores-template.csv">
          Download a template
        </a>
      </p>

      <div className="card roster-form">
        <div className="field">
          <span className="label">Stores from</span>
          <div className="seg" role="radiogroup" aria-label="Stores from">
            {SOURCES.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={source === o.value} className={cx(source === o.value && 'on')} onClick={() => chooseSource(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {source === 'upload' && (
          <div className="field">
            <span className="label">CSV file</span>
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = ''; // picking the same file again re-reads it
              }}
            />
            {input?.kind === 'upload' && <span className="hint">Read {input.fileName} {ago(input.fetchedAt, now)}.</span>}
            <span className="hint">From Google Sheets: File → Download → Comma-separated values. From Excel: Save As → CSV UTF-8.</span>
          </div>
        )}

        {source === 'link' && (
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              fetchLink();
            }}
          >
            <span className="label">Published sheet or CSV link</span>
            <div className="roster-link">
              <input type="url" inputMode="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn ghost" type="submit" disabled={fetching || !url.trim()}>
                {fetching ? 'Fetching…' : fresh || (saved && saved.url === url.trim()) ? 'Refresh' : 'Fetch'}
              </button>
            </div>
            {input?.kind === 'link' ? (
              <span className="hint">Fetched {ago(input.fetchedAt, now)}.</span>
            ) : (
              saved && saved.url === url.trim() && <span className="hint">Last imported from this link {ago(saved.fetchedAt, now)}. Press Refresh to read it again.</span>
            )}
            <span className="hint">Share the sheet as “Anyone with the link” (viewer), or File → Share → Publish to the web. Press Refresh any time after editing it — nothing changes here until you Apply.</span>
          </form>
        )}

        {source === 'paste' && (
          <label className="field">
            <span className="label">Paste cells copied from a sheet</span>
            <textarea rows={6} value={paste} placeholder={'Store name\tROG Exclusive\tCity\tState\tDate\nSan Infotech\tYes\tNashik\tMaharashtra\t24/10/2026'} onChange={(e) => (setPaste(e.target.value), setDone(''))} />
            <span className="hint">Copy straight from the sheet with its header row.</span>
          </label>
        )}

        {problem && <p className="roster-problem">{problem}</p>}

        {parse && (
          <div className="roster-preview">
            <p className="label">
              {plural(parse.rows.length, 'row')} {cols.length ? `· ${cols.join(' · ')}` : ''}
            </p>
            {parse.ignored.length > 0 && (
              <p className="hint">
                Not read: {parse.ignored.slice(0, 6).join(', ')}
                {parse.ignored.length > 6 ? ` and ${parse.ignored.length - 6} more` : ''}.
              </p>
            )}
            <Issues list={parse.errors} tone="bad" />
            <Issues list={parse.warnings} tone="note" />

            {plan && plan.items.length > 0 && (
              <>
                <div className="ss-summary">
                  {(['create', 'update', 'unchanged', 'error'] as const).map((k) => (
                    <Chip key={k} tone={plan.counts[k] ? STATUS[k].tone : 'muted'}>
                      {plan.counts[k]} {k === 'create' ? 'new' : k === 'update' ? 'changed' : k === 'unchanged' ? 'unchanged' : plan.counts[k] === 1 ? 'problem' : 'problems'}
                    </Chip>
                  ))}
                </div>
                <ol className="ss-rows">
                  {plan.items.map((it) => (
                    <Row key={it.row.line} it={it} eventDate={event.date} adminName={adminName(it.row.fields.adminId)} />
                  ))}
                </ol>
                {plan.missing.length > 0 && (
                  <p className="hint ss-missing">
                    <b>{plural(plan.missing.length, 'store')} in this campaign {plan.missing.length === 1 ? 'isn’t' : 'aren’t'} in the sheet</b> — left as {plan.missing.length === 1 ? 'it is' : 'they are'}: {plan.missing.slice(0, 8).map((s) => s.name).join(', ')}
                    {plan.missing.length > 8 ? ` and ${plan.missing.length - 8} more` : ''}.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {done && <p className="ss-done">{done}.</p>}

        {parse && (
          <div className="row end roster-actions">
            <button className="link" onClick={clear}>
              Clear
            </button>
            <button className="btn" disabled={!targets.length || busy} onClick={apply}>
              {busy ? 'Finding locations…' : targets.length && plan ? `Apply: ${[plan.counts.create && `${plan.counts.create} new`, plan.counts.update && `${plan.counts.update} changed`].filter(Boolean).join(', ')}` : 'Nothing to apply'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Row({ it, eventDate, adminName }: { it: PlanItem; eventDate: string; adminName: string | undefined }) {
  const st = STATUS[it.status];
  const f = it.row.fields;
  const errors = [...it.row.errors, ...it.problems];
  return (
    <li className={cx('ss-row', it.status)}>
      <div className="ss-head">
        <Chip tone={st.tone}>{st.label}</Chip>
        <b className="ss-name">{f.name || '(no name)'}</b>
        {f.exclusive && <Chip>ROG Exclusive</Chip>}
        <span className="ss-line">Row {it.row.line}</span>
      </div>
      {it.status === 'create' && <p className="ss-meta">{fieldsText(f, eventDate, adminName) || 'Name only'}</p>}
      {it.status === 'update' && it.store && (
        <ul className="ss-changes">
          {it.changes.map((c) => (
            <li key={c.field}>{changeText(c)}</li>
          ))}
        </ul>
      )}
      {it.status === 'unchanged' && it.store && it.store.name !== f.name && <p className="ss-meta">Matches “{it.store.name}”.</p>}
      {errors.length > 0 && <Issues list={errors.map((m) => ({ line: 0, message: m }))} tone="bad" />}
      {it.row.warnings.length > 0 && <Issues list={it.row.warnings.map((m) => ({ line: 0, message: m }))} tone="note" />}
    </li>
  );
}

function Issues({ list, tone }: { list: { line: number; message: string }[]; tone: 'bad' | 'note' }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 6);
  return (
    <ul className={cx('roster-issues', tone)}>
      {shown.map((e, i) => (
        <li key={i}>
          {e.line > 0 && <span className="ri-line">Row {e.line}</span>}
          {e.message}
        </li>
      ))}
      {list.length > shown.length && (
        <li>
          <button className="link" onClick={() => setAll(true)}>
            Show all {list.length}
          </button>
        </li>
      )}
    </ul>
  );
}
