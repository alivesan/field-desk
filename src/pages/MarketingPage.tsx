import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { update, useApp } from '../lib/db.ts';
import type { Admin, EventMarketing, PlayerContact, Store, TournamentEvent } from '../lib/types.ts';
import {
  adminOf,
  campaignIssues,
  DEFAULT_TEMPLATES,
  PLACEHOLDERS,
  TEMPLATE_FIELD,
  templateOf,
  unknownPlaceholders,
  type TemplateKind,
  defaultDiscordClosing,
  defaultDiscordIntro,
  defaultPlayerIntro,
  defaultRules,
  defaultWhatsappIntro,
  discordPost,
  DISCORD_INVITE,
  DISCORD_LIMIT,
  gameName,
  longDate,
  marketingWeekends,
  MARKETING_MAX,
  posterOf,
  storeIssues,
  whatsappPromo,
  dayOf,
  FIRST_MATCH,
  playerIssues,
  playerMessage,
  PRIZE_POOL,
  REPORTING_TIME,
} from '../lib/marketing.ts';
import { sameJson } from '../lib/submission.ts';
import { campaignStoreNames, storeShortName } from '../lib/names.ts';
import { cx, todayLocal } from '../lib/util.ts';
import { Chip, Field, PageHead, Shell, toast } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { copyText } from '../components/SteamCard.tsx';
import { fetchPrintFile, PrintThumb, shareText } from '../components/PrintCards.tsx';
import '../styles/print.css';
import '../styles/marketing.css';

type Drafts = Record<string, EventMarketing>;
const FIELDS = Object.keys(MARKETING_MAX) as (keyof EventMarketing)[];

const STOCK = new Map<keyof EventMarketing, string>(Object.entries(TEMPLATE_FIELD).map(([kind, field]) => [field, DEFAULT_TEMPLATES[kind as TemplateKind]]));

/** What is kept on the campaign: trimmed, and nothing for an empty box or a template / the rules left as the stock ones. */
function tidy(m: EventMarketing, event: Pick<TournamentEvent, 'games' | 'name'>): EventMarketing {
  const out: EventMarketing = {};
  for (const k of FIELDS) {
    const v = (m[k] ?? '').trim();
    if (v && v !== (k === 'rules' ? defaultRules(gameName(event)) : STOCK.get(k))) out[k] = v;
  }
  return out;
}

/** HQ: any coming weekend's tournaments (this one first) as a Discord post per campaign and a WhatsApp promo per store. Field admins never get here (App.tsx). */
export function MarketingPage() {
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const today = todayLocal();
  const weekends = useMemo(() => marketingWeekends({ events, stores }, today), [events, stores, today]);
  const [picked, setPicked] = useState('');
  const shown = weekends.find((w) => w.weekend.sat === picked) ?? weekends[0]; // the nearest, also once the picked one has passed

  // What HQ is typing, per campaign: the previews follow it at once and it is saved to the campaign a moment after the last key.
  const [drafts, setDrafts] = useState<Drafts>({});
  const optsOf = (event: TournamentEvent): EventMarketing => drafts[event.id] ?? event.marketing ?? {};
  const edit = (event: TournamentEvent, field: keyof EventMarketing, value: string) => setDrafts((d) => ({ ...d, [event.id]: { ...(d[event.id] ?? event.marketing ?? {}), [field]: value } }));

  const pending = useRef<Drafts>({});
  pending.current = drafts;
  const save = () => {
    const todo = Object.entries(pending.current);
    if (!todo.length) return;
    update((d) => {
      for (const [id, draft] of todo) {
        const e = d.events[id];
        if (!e) continue;
        const next = tidy(draft, e);
        if (sameJson(next, e.marketing ?? {})) continue;
        if (Object.keys(next).length) e.marketing = next;
        else delete e.marketing;
      }
    });
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const t = setTimeout(() => saveRef.current(), 700);
    return () => clearTimeout(t);
  }, [drafts]);
  useEffect(() => () => saveRef.current(), []); // leaving the page keeps what was typed

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: 'Marketing' }]}>
      <i className="hq-wide" hidden />
      <PageHead kicker="HQ" title="Marketing." deck="Coming tournaments, written out for Discord, WhatsApp and the players. Pick the weekend, copy the Discord post, send each store its promo with the poster, and the night before, send each store’s players their message." />
      {!shown ? (
        <EmptyCard mark="team" title="No tournaments coming up." hint="Stores with an event day from today on show up here." />
      ) : (
        <>
          {weekends.length > 1 && (
            <div className="mk-picker" role="group" aria-label="Which weekend">
              {weekends.map((w) => (
                <button key={w.weekend.sat} type="button" className={cx('mk-pick', w === shown && 'on')} aria-pressed={w === shown} onClick={() => setPicked(w.weekend.sat)}>
                  <b>{w.label}</b>
                  <span>
                    {w.title} · {w.storeCount} {w.storeCount === 1 ? 'store' : 'stores'}
                  </span>
                </button>
              ))}
            </div>
          )}
          <section key={shown.weekend.sat} className="hs mk-weekend" aria-label={shown.title}>
            <header className="hs-head">
              <h2>{shown.title}</h2>
              <span className="label">{shown.label}</span>
            </header>
            {shown.campaigns.map((c) => (
              <Campaign key={c.event.id} event={c.event} stores={c.stores} opts={optsOf(c.event)} onEdit={(f, v) => edit(c.event, f, v)} />
            ))}
          </section>
        </>
      )}
    </Shell>
  );
}

function Campaign({ event, stores, opts, onEdit }: { event: TournamentEvent; stores: Store[]; opts: EventMarketing; onEdit: (field: keyof EventMarketing, value: string) => void }) {
  const game = gameName(event);
  const issues = campaignIssues(event, opts);
  const admins = useApp((s) => s.admins);
  const post = discordPost(event, stores, opts);
  const allStores = useApp((s) => s.stores);
  const names = useMemo(() => campaignStoreNames(Object.values(allStores), event.id), [allStores, event.id]);
  return (
    <article className="mk-camp">
      <header className="mk-camp-head">
        <h3>{event.name}</h3>
        <span className="label">
          {game} · {stores.length} {stores.length === 1 ? 'store' : 'stores'}
        </span>
      </header>

      <details className="mk-settings">
        <summary>Prize pool and times</summary>
        <div className="card mk-form">
          <div className="mk-grid">
            <Field label="Prize pool (₹)" value={opts.prizePool ?? ''} onChange={(v) => onEdit('prizePool', v)} placeholder={PRIZE_POOL} />
            <Field label="Reporting time" value={opts.reportingTime ?? ''} onChange={(v) => onEdit('reportingTime', v)} placeholder={REPORTING_TIME} />
            <Field label="First match" value={opts.firstMatch ?? ''} onChange={(v) => onEdit('firstMatch', v)} placeholder={FIRST_MATCH} />
          </div>
          <p className="mk-note">An empty box uses the grey text. Saved on the campaign a moment after you stop typing; all three messages use them.</p>
        </div>
      </details>

      <RulesBlock game={game} rules={opts.rules ?? ''} issues={issues} onEdit={(v) => onEdit('rules', v)} />

      <section className="mk-block" aria-label={`Discord post for ${event.name}`}>
        <header className="mk-block-head">
          <h4>
            <b>1</b> Discord post
          </h4>
          <Chip tone={post.length > DISCORD_LIMIT ? 'warn' : 'muted'}>
            {post.length} / {DISCORD_LIMIT} characters
          </Chip>
          <button type="button" className="btn accent" onClick={() => void copyText(post, 'Discord post')}>
            Copy
          </button>
        </header>
        <TemplateEditor kind="discord" opts={opts} onEdit={onEdit}>
          <Field label="Discord intro — {intro}" multiline value={opts.discordIntro ?? ''} onChange={(v) => onEdit('discordIntro', v)} placeholder={defaultDiscordIntro(game)} />
          <Field label="Discord closing — {closing}" multiline value={opts.discordClosing ?? ''} onChange={(v) => onEdit('discordClosing', v)} placeholder={defaultDiscordClosing(game)} />
        </TemplateEditor>
        {post.length > DISCORD_LIMIT && <p className="mk-warn">Discord refuses a message over {DISCORD_LIMIT} characters — shorten the intro or closing, or post it in two parts.</p>}
        {stores.some((s) => storeIssues(s).length > 0) && <p className="mk-warn">Some stores are missing links — the post shows them as [… missing]; the store cards below say which.</p>}
        <pre className="mk-pre">{post}</pre>
      </section>

      <section className="mk-block" aria-label={`WhatsApp promos for ${event.name}`}>
        <header className="mk-block-head">
          <h4>
            <b>2</b> WhatsApp promos
          </h4>
          <span className="label">one per store, with its poster</span>
        </header>
        <TemplateEditor kind="whatsapp" opts={opts} onEdit={onEdit}>
          <Field label="WhatsApp paragraph — {intro}" multiline value={opts.whatsappIntro ?? ''} onChange={(v) => onEdit('whatsappIntro', v)} placeholder={defaultWhatsappIntro(game)} />
          <Field label="Discord invite — {discordInvite}" value={opts.discordInvite ?? ''} onChange={(v) => onEdit('discordInvite', v)} placeholder={DISCORD_INVITE} />
        </TemplateEditor>
        <ul className="mk-stores">
          {stores.map((s) => (
            <StoreCard key={s.id} event={event} store={s} caption={whatsappPromo(event, s, opts)} short={storeShortName(s.name, names)} />
          ))}
        </ul>
      </section>

      <section className="mk-block" aria-label={`Players’ messages for ${event.name}`}>
        <header className="mk-block-head">
          <h4>
            <b>3</b> Players — the night before
          </h4>
          <span className="label">one per store, to its registered players</span>
        </header>
        <TemplateEditor kind="player" opts={opts} onEdit={onEdit}>
          <Field label="Line under the date — {intro}" value={opts.playerIntro ?? ''} onChange={(v) => onEdit('playerIntro', v)} placeholder={defaultPlayerIntro(game)} />
          <p className="mk-note">The rules are in Tournament rules, above.</p>
        </TemplateEditor>
        <ul className="mk-stores">
          {stores.map((s) => (
            <PlayerCard key={s.id} event={event} store={s} admins={admins} opts={opts} short={storeShortName(s.name, names)} />
          ))}
        </ul>
      </section>
    </article>
  );
}

/** One store: its caption, its poster, and the ways to get both onto a phone. */
function StoreCard({ event, store, caption, short }: { event: TournamentEvent; store: Store; caption: string; short: string }) {
  const poster = posterOf(store);
  const href = `/api/print/file/${encodeURIComponent(store.id)}/poster`;
  const issues = storeIssues(store);
  const file = useRef<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false); // the poster is fetched; the next tap shares at once

  const share = async () => {
    if (busy) return;
    if (!poster) return void (await shareText(caption));
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
      await copyText(caption, 'Caption');
      toast('This device can’t send a picture with text — caption copied. Download the poster and add it in WhatsApp.', { tone: 'warn' });
      return;
    }
    setBusy(true);
    try {
      let f = file.current;
      if (!f) {
        f = await fetchPrintFile(href, `${short} - Poster`);
        if (!navigator.canShare({ files: [f] })) {
          await copyText(caption, 'Caption');
          toast('This device can’t share the poster — caption copied. Download the poster and add it in WhatsApp.', { tone: 'warn' });
          return;
        }
        file.current = f;
      }
      await navigator.share({ files: [f], text: caption });
      setReady(false);
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError') return; // closed the sheet
      if (name === 'NotAllowedError' && file.current) {
        // The download took long enough that the browser wants a fresh tap; the poster is ready now.
        setReady(true);
        toast('Poster is ready — tap Share again', { tone: 'accent' });
      } else {
        await copyText(caption, 'Caption');
        toast('Couldn’t share the poster — caption copied instead', { tone: 'warn' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="mk-store">
      <header className="mk-store-head">
        <h5>{short}</h5>
        <span className="label">
          {store.city || 'No city'} · {longDate(dayOf(store, event))}
        </span>
      </header>
      {issues.length > 0 && (
        <p className="mk-chips">
          {issues.map((i) => (
            <Chip key={i} tone="warn">
              {i}
            </Chip>
          ))}
        </p>
      )}
      <div className={cx('mk-store-body', !poster && 'no-poster')}>
        {poster ? (
          <div className="mk-poster">
            <PrintThumb driveId={poster.driveId} alt={`${short} poster`} href={`${href}?inline=1`} width={240} />
          </div>
        ) : (
          <p className="mk-warn">No poster in this store’s print kit — the caption can still be copied or shared without it.</p>
        )}
        <pre className="mk-pre">{caption}</pre>
      </div>
      <div className="mk-actions">
        <button type="button" className="btn accent" onClick={() => void share()} disabled={busy} aria-busy={busy}>
          {busy ? 'Getting it…' : ready ? 'Share now' : poster ? 'Share poster + caption' : 'Share caption'}
        </button>
        <button type="button" className="btn ghost" onClick={() => void copyText(caption, 'Caption')}>
          Copy caption
        </button>
        {poster && (
          <a className="btn ghost" href={href} download>
            Download poster
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * The campaign's rules, in view and editable: the stock rules for its game shown as text (a Tekken campaign starts with the
 * owner's Tekken rules). tidy() saves them only once they differ from those — so a better stock list reaches campaigns nobody edited.
 */
function RulesBlock({ game, rules, issues, onEdit }: { game: string; rules: string; issues: string[]; onEdit: (value: string) => void }) {
  const stock = defaultRules(game);
  const value = rules || stock;
  const custom = !!rules.trim() && rules.trim() !== stock;
  return (
    <section className="mk-block" aria-label={`Tournament rules for ${game}`}>
      <header className="mk-block-head">
        <h4>Tournament rules</h4>
        <span className="label">{game} · in the players’ message as {'{rules}'}</span>
        {custom && <Chip tone="muted">Your own</Chip>}
        {issues.map((i) => (
          <Chip key={i} tone="warn">
            {i}
          </Chip>
        ))}
        <button type="button" className="btn ghost" disabled={!value.trim()} onClick={() => void copyText(value.trim(), 'Rules')}>
          Copy
        </button>
      </header>
      <label className="field mk-rules">
        <span className="label">One rule per line — edit them here for this campaign</span>
        <textarea
          className="mk-template-box"
          value={value}
          rows={Math.min(22, Math.max(5, value.split('\n').length + 1))}
          placeholder="One rule per line, e.g. – Format: Single Elimination"
          onChange={(e) => onEdit(e.target.value)}
        />
      </label>
      {custom && stock && (
        <button type="button" className="link" onClick={() => onEdit('')}>
          Back to the stock {game} rules
        </button>
      )}
    </section>
  );
}

/** A block's "Edit template": its texts, then the whole layout with the {placeholders} it understands (tap one to put it at the cursor). */
function TemplateEditor({ kind, opts, onEdit, open, children }: { kind: TemplateKind; opts: EventMarketing; onEdit: (field: keyof EventMarketing, value: string) => void; open?: boolean; children: ReactNode }) {
  const field = TEMPLATE_FIELD[kind];
  const value = opts[field] || DEFAULT_TEMPLATES[kind]; // emptied → the stock one again
  const custom = templateOf(kind, opts) !== DEFAULT_TEMPLATES[kind];
  const unknown = unknownPlaceholders(kind, value);
  const box = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null); // where the cursor goes once an inserted placeholder is in the box
  useLayoutEffect(() => {
    const el = box.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  const insert = (key: string) => {
    const el = box.current;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
    const tag = `{${key}}`;
    caret.current = a + tag.length;
    onEdit(field, value.slice(0, a) + tag + value.slice(b));
  };
  return (
    <details className="mk-settings mk-template" open={open}>
      <summary>
        Edit template
        {custom && <Chip tone="muted">Your own</Chip>}
        {unknown.length > 0 && <Chip tone="warn">Check {unknown.map((k) => `{${k}}`).join(' ')}</Chip>}
      </summary>
      <div className="card mk-form">
        {children}
        <label className="field">
          <span className="label">Template</span>
          <textarea ref={box} className="mk-template-box" value={value} rows={Math.min(24, value.split('\n').length + 2)} spellCheck={false} onChange={(e) => onEdit(field, e.target.value)} />
        </label>
        {unknown.length > 0 && <p className="mk-warn">{unknown.map((k) => `{${k}}`).join(', ')} isn’t a placeholder here — it’s sent as typed. Check the spelling against the list below.</p>}
        <p className="mk-note">Tap a placeholder to put it where the cursor is. Everything else is sent exactly as typed — *bold* for WhatsApp, **bold** for Discord.</p>
        <ul className="mk-phs">
          {PLACEHOLDERS[kind].map((p) => (
            <li key={p.key}>
              <button type="button" className="mk-ph" onClick={() => insert(p.key)}>
                <code>{`{${p.key}}`}</code> <span>{p.what}</span>
              </button>
            </li>
          ))}
        </ul>
        {custom && (
          <button type="button" className="link" onClick={() => onEdit(field, '')}>
            Back to the stock template
          </button>
        )}
      </div>
    </details>
  );
}

const trimmed = (c: PlayerContact): PlayerContact => {
  const out: PlayerContact = {};
  if (c.name?.trim()) out.name = c.name.trim();
  if (c.phone?.trim()) out.phone = c.phone.trim();
  return out;
};

/** One store's night-before message to its players: who to call (typed here, else the assigned admin), the text and a Copy. */
function PlayerCard({ event, store, admins, opts, short }: { event: TournamentEvent; store: Store; admins: Record<string, Admin>; opts: EventMarketing; short: string }) {
  // What HQ is typing: the message follows at once; saved on the store a moment after the last key, and when leaving the page.
  const [contact, setContact] = useState<PlayerContact>(store.playerContact ?? {});
  const saveRef = useRef(() => {});
  saveRef.current = () => {
    const next = trimmed(contact);
    if (sameJson(next, store.playerContact ?? {})) return;
    update((d) => {
      const s = d.stores[store.id];
      if (!s) return;
      if (Object.keys(next).length) s.playerContact = next;
      else delete s.playerContact;
    });
  };
  useEffect(() => {
    const t = setTimeout(() => saveRef.current(), 700);
    return () => clearTimeout(t);
  }, [contact]);
  useEffect(() => () => saveRef.current(), []);

  const typed = { ...store, playerContact: contact };
  const assigned = adminOf({ ...store, playerContact: undefined }, admins);
  const issues = playerIssues(typed, admins);
  const message = playerMessage(event, typed, admins, opts);
  return (
    <li className="mk-store">
      <header className="mk-store-head">
        <h5>{short}</h5>
        <span className="label">
          {store.city || 'No city'} · {longDate(dayOf(store, event))}
        </span>
      </header>
      {issues.length > 0 && (
        <p className="mk-chips">
          {issues.map((i) => (
            <Chip key={i} tone="warn">
              {i}
            </Chip>
          ))}
        </p>
      )}
      <div className="mk-grid mk-contact">
        <Field label="Admin name — {adminName}" value={contact.name ?? ''} onChange={(v) => setContact((c) => ({ ...c, name: v }))} placeholder={assigned.name || 'Who players call'} />
        <Field label="Admin number — {adminPhone}" type="tel" value={contact.phone ?? ''} onChange={(v) => setContact((c) => ({ ...c, phone: v }))} placeholder={contact.name?.trim() ? 'Their number' : assigned.phone || 'Their number'} />
      </div>
      <pre className="mk-pre">{message}</pre>
      <div className="mk-actions">
        <button type="button" className="btn accent" onClick={() => void copyText(message, 'Players’ message')}>
          Copy message
        </button>
      </div>
    </li>
  );
}
