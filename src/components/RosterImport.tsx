import { useMemo, useState } from 'react';
import type { Player, RosterSource, Store, TournamentEvent } from '../lib/types.ts';
import { discardWork, sendCommand, updateStore, usePendingWork, useSync, type PendingWork } from '../lib/db.ts';
import { applyCommand, dayVersion, type Command, type CommandContext } from '../lib/commands.ts';
import { COLUMN_LABEL, decodeText, diffRoster, diffSummary, looksLikeHtml, parseRoster, readyStores, type RosterAnswer, type RosterDiff, type RosterParse, type RosterQuestion, type StoreRoster } from '../lib/roster.ts';
import { maskPhone } from '../lib/phone.ts';
import { keepOnSpot } from '../lib/onspot.ts';
import { ago, cx } from '../lib/util.ts';
import { askConfirm, Chip, useNow } from './ui.tsx';
import '../styles/roster.css';
import '../styles/onspot.css';

/*
 * HQ: players from an uploaded CSV, a published sheet link (fetched by our server, refreshable)
 * or a pasted list — for one store (inside its Players & bracket page) or every store of a
 * campaign at once. Duplicate numbers / names come back as questions ("which one is it?") HQ
 * answers here. Nothing is sent until "Load players": then each store gets a 'players.set'
 * command (HQ-only, server-authoritative) and its roster source is noted on the store. The list
 * order is the seed order; the bracket is the next step on the store page. Parsing lives in
 * src/lib/roster.ts.
 */

type Source = 'upload' | 'link' | 'paste';
type LoadStatus = 'create' | 'update' | 'unchanged' | 'started';

interface Input {
  kind: 'upload' | 'link';
  text: string;
  fileName?: string;
  url?: string;
  fetchedAt: string;
}

interface Plan {
  roster: StoreRoster;
  store: Store;
  status: LoadStatus | 'errors' | 'absent' | 'questions';
  diff: RosterDiff | null;
  lostCheckIns: number; // checked-in players this load would drop (removed, or a new phone = new id)
  players: Player[]; // what Load sends: the file's players, then any walk-ins kept
  walkIns: Player[]; // on-spot players on the store's list but not in this file — kept unless HQ drops them
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
      return 'That sheet is too large to import. Keep it to the player list (a few thousand rows at most).';
    case 'upstream':
      return `The sheet couldn’t be fetched${body.error ? ` (${body.error})` : ''}. Check it’s shared “Anyone with the link” or published to the web.`;
  }
  if (status === 404) return 'Fetching sheet links isn’t available on this server yet — download the sheet as CSV and upload it instead.';
  if (status === 401 || status === 403) return 'Only HQ can fetch sheet links. Sign in as HQ and try again.';
  return body?.error ?? `The server couldn’t fetch the link (HTTP ${status}).`;
}

/** What "Load players" does at a store: the same "under way" test as the players.set handler. */
function loadStatus(store: Store, players: Player[]): { status: LoadStatus; diff: RosterDiff } {
  const diff = diffRoster(store.day.players, players);
  if (store.day.matches.some((m) => !m.bye && m.status !== 'pending')) return { status: 'started', diff };
  if (!store.day.players.length) return { status: 'create', diff };
  return { status: diff.same ? 'unchanged' : 'update', diff };
}

/**
 * `single`: inside one store's page — no campaign list, no store picker. `campaign` (with single):
 * every store of the campaign, so a Store column can tell this store's rows from the others'.
 * `onLoaded`: after Load players has sent its commands.
 */
export function RosterImport({ event, stores, single, campaign, onLoaded }: { event: TournamentEvent; stores: Store[]; single?: boolean; campaign?: Store[]; onLoaded?: () => void }) {
  const sync = useSync();
  const now = useNow(30000);
  const work = usePendingWork();
  const [source, setSource] = useState<Source>('upload');
  const [scopeChoice, setScope] = useState('all'); // 'all' = the whole campaign via the Store column, else a store id
  const scope = single ? stores[0].id : scopeChoice;
  const [answers, setAnswers] = useState<Record<string, RosterAnswer>>({});
  const [input, setInput] = useState<Input | null>(null);
  const [paste, setPaste] = useState('');
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState<{ id: string; storeName: string }[]>([]); // work of the last load, to show its progress
  const [refused, setRefused] = useState<{ storeName: string; message: string }[]>([]); // checked here before sending
  const [dropWalkIns, setDropWalkIns] = useState(false); // on-spot players not in the file: kept unless HQ says drop

  const text = source === 'paste' ? paste : input?.kind === source ? input.text : '';
  const among = single && campaign?.some((s) => s.id === stores[0].id) ? campaign : stores;
  const storeKey = among.map((s) => `${s.id}|${s.name}|${s.city}`).join('\n');
  const parse: RosterParse | null = useMemo(
    () => (text.trim() ? parseRoster(text, { stores: among.map((s) => ({ id: s.id, name: s.name, city: s.city })), storeId: scope === 'all' ? null : scope, answers }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, storeKey, scope, answers],
  );
  const answer = (key: string, value: RosterAnswer) => setAnswers((a) => ({ ...a, [key]: value }));

  const byId = new Map(stores.map((s) => [s.id, s]));
  const plans: Plan[] = (parse?.stores ?? []).flatMap((roster): Plan[] => {
    const store = byId.get(roster.storeId);
    if (!store) return [];
    const none = { diff: null, lostCheckIns: 0, players: roster.players, walkIns: [] };
    if (roster.errors.length) return [{ roster, store, status: 'errors', ...none }];
    if (roster.questions.length) return [{ roster, store, status: 'questions', ...none }];
    if (!roster.players.length) return [{ roster, store, status: 'absent', ...none }];
    // Walk-ins registered at the desk aren't in HQ's file: kept after its players unless HQ drops them.
    const keep = keepOnSpot(store.day, roster.players);
    const players = dropWalkIns ? roster.players : keep.players;
    const { status, diff } = loadStatus(store, players);
    const dropped = [...diff.removed, ...diff.phoneChanged.map((c) => c.from)];
    return [{ roster, store, status, diff, lostCheckIns: dropped.filter((p) => store.day.checkIn[p.id]).length, players, walkIns: keep.kept }];
  });
  const ready = new Set(parse ? readyStores(parse).map((r) => r.storeId) : []);
  const targets = plans.filter((p) => ready.has(p.store.id) && (p.status === 'create' || p.status === 'update'));

  const chooseSource = (s: Source) => {
    setSource(s);
    setProblem('');
    setAnswers({});
  };

  const onFile = async (file: File | undefined) => {
    setProblem('');
    if (!file) return;
    if (/\.(xlsx|xlsm|xls|ods|numbers)$/i.test(file.name)) {
      setProblem('That’s a spreadsheet file, not a CSV. In Google Sheets use File → Download → CSV; in Excel, Save As → CSV UTF-8. Then upload that.');
      return;
    }
    if (file.size > 2_000_000) {
      setProblem('That file is over 2 MB — upload just the player list as CSV.');
      return;
    }
    try {
      setAnswers({});
      setInput({ kind: 'upload', text: decodeText(new Uint8Array(await file.arrayBuffer())), fileName: file.name, fetchedAt: new Date().toISOString() });
    } catch {
      setProblem('This browser couldn’t read that file. Try saving it again as CSV.');
    }
  };

  const fetchLink = async (link: string, forScope?: string) => {
    const u = link.trim();
    if (!u) return;
    setSource('link');
    setUrl(u);
    if (forScope) setScope(forScope);
    setProblem('');
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
    setAnswers({});
    setSent([]);
    setRefused([]);
    setDropWalkIns(false);
  };

  const load = async () => {
    if (!targets.length) return;
    const lost = targets.reduce((n, p) => n + p.lostCheckIns, 0);
    const updates = targets.filter((p) => p.status === 'update').length;
    if (
      updates &&
      !(await askConfirm(
        `Replace the players at ${updates} store${updates === 1 ? '' : 's'}? A bracket that hasn’t started is cleared — build it again in the Bracket step.` +
          (lost ? ` ${lost} checked-in player${lost === 1 ? '' : 's'} will lose the check-in (removed from the list, or a new phone number).` : ' Check-ins carry over for players still on the list.'),
        { ok: 'Replace players' },
      ))
    )
      return;
    const at = new Date().toISOString();
    const ctx: CommandContext = { commandId: 'roster-precheck', now: at, actor: { principal: sync.principal ?? 'super', name: sync.name ?? 'HQ', role: sync.role ?? 'super' }, event };
    const ids: { id: string; storeName: string }[] = [];
    const bad: { storeName: string; message: string }[] = [];
    for (const { roster, store, players } of targets) {
      const cmd: Command = { type: 'players.set', base: dayVersion(store), players };
      try {
        applyCommand(store, cmd, ctx); // the same check the server makes, so a refusal shows here at once
        ids.push({ id: sendCommand(store.id, cmd), storeName: store.name });
      } catch (e) {
        bad.push({ storeName: store.name, message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const src: RosterSource = { kind: source, fetchedAt: input?.kind === source ? input.fetchedAt : at, rows: roster.players.length, by: sync.principal ?? 'super' };
      if (source === 'link' && input?.url) src.url = input.url;
      if (source === 'upload' && input?.fileName) src.fileName = input.fileName;
      updateStore(store.id, (s) => {
        s.roster = src;
      });
    }
    setSent(ids);
    setRefused(bad);
    if (ids.length && !bad.length) onLoaded?.();
  };

  // This load's work plus any earlier player load for these stores still waiting or refused.
  const mine = new Set(stores.map((s) => s.id));
  const loads = work.filter((w) => w.kind === 'cmd' && (w.cmd?.type === 'players.set' || w.cmd?.type === 'bracket.load') && w.storeId && mine.has(w.storeId));
  const progress = [...sent, ...loads.filter((w) => !sent.some((x) => x.id === w.id)).map((w) => ({ id: w.id, storeName: byId.get(w.storeId!)?.name ?? 'A store' }))];

  const linked = stores.filter((s) => s.roster?.kind === 'link' && s.roster.url);
  const shared = (u: string) => linked.filter((s) => s.roster!.url === u).length;

  return (
    <section className={cx('roster-import', single && 'single')}>
      {!single && (
        <div className="index-head">
          <h2>Players for several stores</h2>
        </div>
      )}
      <p className="hint">
        {single
          ? 'Upload the player list, link a sheet or paste it. '
          : 'One file for the whole campaign, split by a Store column. The order in the file is the seed order; the bracket is then built on each store’s Players & bracket page. '}
        Columns: <b>Name</b> (required), <b>Phone</b>{single ? '' : ', '}
        {!single && <b>Store</b>}, <b>Seed</b>, <b>IGN</b> (in-game name). Other columns, such as email or Discord, aren’t kept. <b>Players need a phone number to check themselves in with the QR.</b>
      </p>

      {!single && <div className="roster-current">
        <ol>
          {stores.map((s) => {
            const d = s.day;
            const started = d.matches.some((m) => !m.bye && m.status !== 'pending');
            const withPhone = d.players.filter((p) => p.phone).length;
            return (
              <li key={s.id}>
                <span className="rc-name">{s.name}</span>
                <span className="rc-meta">
                  {d.players.length ? `${d.players.length} players${started ? ' · under way' : ''}` : 'No players yet'}
                  {s.roster && ` · ${sourceLabel(s.roster)} ${ago(s.roster.fetchedAt, now)}`}
                  {d.players.length > 0 && withPhone < d.players.length && withPhone > 0 && ` · ${d.players.length - withPhone} without phone`}
                </span>
                {s.roster?.kind === 'link' && s.roster.url && (
                  <span className="rc-refresh">
                    <button className="link" disabled={fetching} onClick={() => fetchLink(s.roster!.url!, s.id)}>
                      Refresh from link
                    </button>
                    {shared(s.roster.url) > 1 && (
                      <button className="link" disabled={fetching} onClick={() => fetchLink(s.roster!.url!, 'all')}>
                        All {shared(s.roster.url)} stores
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>}
      {single && stores[0].roster?.kind === 'link' && stores[0].roster.url && (
        <p className="hint">
          Last loaded from a sheet link {ago(stores[0].roster.fetchedAt, now)} ·{' '}
          <button className="link" disabled={fetching} onClick={() => fetchLink(stores[0].roster!.url!)}>
            Refresh from link
          </button>
        </p>
      )}

      <div className="card roster-form">
        <div className="roster-controls">
          <div className="field">
            <span className="label">Players from</span>
            <div className="seg" role="radiogroup" aria-label="Players from">
              {SOURCES.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={source === o.value} className={cx(source === o.value && 'on')} onClick={() => chooseSource(o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {!single && <label className="field roster-scope">
            <span className="label">For</span>
            <select value={scope} onChange={(e) => (setScope(e.target.value), setAnswers({}))}>
              <option value="all">Whole campaign — by the Store column</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  Only {s.name}
                </option>
              ))}
            </select>
          </label>}
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
              fetchLink(url);
            }}
          >
            <span className="label">Published sheet or CSV link</span>
            <div className="roster-link">
              <input type="url" inputMode="url" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn ghost" type="submit" disabled={fetching || !url.trim()}>
                {fetching ? 'Fetching…' : input?.kind === 'link' && input.url === url.trim() ? 'Refresh' : 'Fetch'}
              </button>
            </div>
            {input?.kind === 'link' && <span className="hint">Last fetched {ago(input.fetchedAt, now)}.</span>}
            <span className="hint">The sheet must be shared “Anyone with the link” (viewer) or “Published to the web”. Press Refresh any time to pick up edits — nothing changes until you load.</span>
          </form>
        )}

        {source === 'paste' && (
          <label className="field">
            <span className="label">Paste names, or cells copied from a sheet</span>
            <textarea rows={6} value={paste} placeholder={'Name, Phone, Store\nAsha Rao, 98200 11111, San Infotech\n…'} onChange={(e) => setPaste(e.target.value)} />
            <span className="hint">One player per line. Copy straight from a sheet (header row included) to keep phones and stores.</span>
          </label>
        )}

        {problem && <p className="roster-problem">{problem}</p>}

        {parse && <Preview parse={parse} plans={plans} answers={answers} onAnswer={answer} single={!!single} dropWalkIns={dropWalkIns} onDropWalkIns={setDropWalkIns} />}

        {parse && (
          <div className="row end roster-actions">
            <button className="link" onClick={clear}>
              Clear
            </button>
            <button className="btn" disabled={!targets.length} onClick={load}>
              {single ? 'Load players' : targets.length ? `Load players into ${targets.length} store${targets.length === 1 ? '' : 's'}` : 'Load players'}
            </button>
          </div>
        )}

        {(progress.length > 0 || refused.length > 0) && (
          <ul className="roster-progress">
            {refused.map((r) => (
              <li key={r.storeName} className="bad">
                <b>{r.storeName}</b> — not sent: {r.message}
              </li>
            ))}
            {progress.map((p) => (
              <Progress key={p.id} id={p.id} storeName={p.storeName} work={work.find((w) => w.id === p.id)} offline={sync.connection === 'offline'} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function sourceLabel(r: RosterSource) {
  if (r.kind === 'link') return 'from sheet link';
  if (r.kind === 'upload') return r.fileName ? `from ${r.fileName}` : 'from upload';
  return 'pasted';
}

const STATUS: Record<Plan['status'], { tone?: 'ok' | 'warn' | 'muted'; label: string }> = {
  create: { tone: 'ok', label: 'Sets the players' },
  update: { label: 'Replaces the players' },
  unchanged: { tone: 'muted', label: 'Unchanged' },
  started: { tone: 'warn', label: 'Matches under way — skipped' },
  errors: { tone: 'warn', label: 'Fix the rows below' },
  questions: { tone: 'warn', label: 'Answer below' },
  absent: { tone: 'muted', label: 'Not in this list' },
};

/** "Same number on rows 4 and 9 — which one is it?" — pick a row, or keep them all. */
function Question({ q, value, onAnswer }: { q: RosterQuestion; value: RosterAnswer | undefined; onAnswer: (key: string, v: RosterAnswer) => void }) {
  return (
    <fieldset className="rq">
      <legend>{q.title}</legend>
      {q.options.map((o) => (
        <label key={o.line} className={cx('rq-opt', value === o.line && 'on')}>
          <input type="radio" name={q.key} checked={value === o.line} onChange={() => onAnswer(q.key, o.line)} />
          <span>
            <b>{o.name}</b>
            <small>
              Row {o.line}
              {o.phone ? ` · ${maskPhone(o.phone)}` : ' · no phone'}
              {o.ign && ` · ${o.ign}`}
            </small>
          </span>
        </label>
      ))}
      <label className={cx('rq-opt', value === 'all' && 'on')}>
        <input type="radio" name={q.key} checked={value === 'all'} onChange={() => onAnswer(q.key, 'all')} />
        <span>
          <b>{q.both.split(' — ')[0]}</b>
          <small>{q.both.split(' — ').slice(1).join(' — ')}</small>
        </span>
      </label>
    </fieldset>
  );
}

function Preview({
  parse,
  plans,
  answers,
  onAnswer,
  single,
  dropWalkIns,
  onDropWalkIns,
}: {
  parse: RosterParse;
  plans: Plan[];
  answers: Record<string, RosterAnswer>;
  onAnswer: (key: string, v: RosterAnswer) => void;
  single: boolean;
  dropWalkIns: boolean;
  onDropWalkIns: (drop: boolean) => void;
}) {
  const cols = Object.entries(parse.columns).map(([k, h]) => `${h} → ${COLUMN_LABEL[k as keyof typeof COLUMN_LABEL]}`);
  return (
    <div className="roster-preview">
      <p className="label">
        {parse.rows} row{parse.rows === 1 ? '' : 's'} · {parse.kind === 'table' ? cols.join(' · ') : 'a list without a header row'}
      </p>
      {parse.ignored.length > 0 && (
        <p className="hint">
          Not kept: {parse.ignored.slice(0, 6).join(', ')}
          {parse.ignored.length > 6 ? ` and ${parse.ignored.length - 6} more` : ''} — these columns aren’t read or stored.
        </p>
      )}
      <Issues list={parse.errors} tone="bad" />
      <Issues list={parse.warnings} tone="note" />
      <ol className="roster-stores">
        {plans.map((p) => {
          const st = STATUS[p.status];
          const shown = p.roster.entries.slice(0, 5);
          const summary = p.diff && p.status === 'update' ? diffSummary(p.diff) : '';
          return (
            <li key={p.store.id} className={cx('rs', p.status === 'absent' && 'quiet')}>
              <div className="rs-head">
                {!single && <h4>{p.store.name}</h4>}
                <span className="rs-count">{p.players.length ? `${p.players.length} players` : '—'}</span>
                <Chip tone={st.tone}>{st.label}</Chip>
              </div>
              {p.status === 'started' && <p className="hint">Reset the bracket first (this store → Players &amp; bracket → Bracket), then load again.</p>}
              {p.roster.questions.length > 0 && (
                <div className="rq-list">
                  {p.roster.questions.map((q) => (
                    <Question key={q.key} q={q} value={answers[q.key]} onAnswer={onAnswer} />
                  ))}
                </div>
              )}
              {p.walkIns.length > 0 && p.status !== 'started' && <WalkIns walkIns={p.walkIns} dropped={dropWalkIns} onDrop={onDropWalkIns} />}
              {summary && <p className="rs-diff">{summary}</p>}
              {p.diff && p.status === 'update' && <DiffNames diff={p.diff} />}
              {p.lostCheckIns > 0 && p.status === 'update' && (
                <p className="rs-warn">
                  {p.lostCheckIns} checked-in player{p.lostCheckIns === 1 ? '' : 's'} would lose the check-in.
                </p>
              )}
              {shown.length > 0 && (
                <ol className="rs-names">
                  {shown.map((e) => (
                    <li key={e.player.id}>
                      <span className="rs-seed">{e.player.seed}</span>
                      <span className="rs-player">
                        {e.player.name}
                        {e.player.ign && <small className="ign"> · {e.player.ign}</small>}
                      </span>
                      <span className={cx('rs-phone', !e.player.phone && 'none')}>{e.player.phone ? maskPhone(e.player.phone) : 'no phone'}</span>
                    </li>
                  ))}
                  {p.roster.entries.length > shown.length && <li className="rs-more">+ {p.roster.entries.length - shown.length} more</li>}
                </ol>
              )}
              <Issues list={p.roster.errors} tone="bad" />
              <Issues list={p.status === 'absent' ? [] : p.roster.warnings} tone="note" />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** "2 on-spot players kept — not in this file: …", with the choice to drop them (for every store in this load). */
function WalkIns({ walkIns, dropped, onDrop }: { walkIns: Player[]; dropped: boolean; onDrop: (drop: boolean) => void }) {
  const n = walkIns.length;
  const names = walkIns.slice(0, 6).map((p) => p.name).join(', ') + (n > 6 ? ` and ${n - 6} more` : '');
  const who = `${n} on-spot player${n === 1 ? '' : 's'}`;
  return (
    <p className={cx('rs-onspot', dropped && 'dropped')}>
      {dropped ? (
        <>
          <b>{who} removed</b> — registered at the desk, not in this file: {names}. Their registrations stay under On-spot registrations.{' '}
          <button className="link" onClick={() => onDrop(false)}>
            Keep {n === 1 ? 'them' : 'them all'}
          </button>
        </>
      ) : (
        <>
          <b>{who} kept</b> — not in this file: {names}. They were registered at the desk, so they stay after the file’s players, check-in kept.{' '}
          <button className="link" onClick={() => onDrop(true)}>
            Drop {n === 1 ? 'them' : 'them all'}
          </button>
        </>
      )}
    </p>
  );
}

function DiffNames({ diff }: { diff: RosterDiff }) {
  const few = (names: string[]) => names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  const lines: [string, string[]][] = [
    ['Added', diff.added.map((p) => p.name)],
    ['Removed', diff.removed.map((p) => p.name)],
    ['Renamed', diff.renamed.map((c) => `${c.from.name} → ${c.to.name}`)],
    ['New phone', diff.phoneChanged.map((c) => c.to.name)],
    ['In-game name', diff.ignChanged.map((c) => `${c.to.name}: ${c.from.ign ?? '—'} → ${c.to.ign ?? '—'}`)],
  ];
  const shown = lines.filter(([, n]) => n.length);
  if (!shown.length) return null;
  return (
    <dl className="rs-changes">
      {shown.map(([k, n]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{few(n)}</dd>
        </div>
      ))}
    </dl>
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
          {e.line > 0 && !/^Rows? \d/.test(e.message) && <span className="ri-line">Row {e.line}</span>}
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

function Progress({ id, storeName: name, work, offline }: { id: string; storeName: string; work: PendingWork | undefined; offline: boolean }) {
  if (!work)
    return (
      <li className="ok">
        <b>{name}</b> — loaded.
      </li>
    );
  if (work.state === 'queued' || work.state === 'sending')
    return (
      <li>
        <b>{name}</b> — {offline ? 'saved on this device, will send when back online' : work.state === 'sending' ? 'sending…' : 'queued…'}
      </li>
    );
  return (
    <li className="bad">
      <b>{name}</b> — {work.state === 'conflict' ? 'refused by the server' : 'couldn’t be sent'}: {work.error ?? 'no reason given.'}{' '}
      <button className="link" onClick={() => discardWork(id)}>
        Dismiss
      </button>
    </li>
  );
}
