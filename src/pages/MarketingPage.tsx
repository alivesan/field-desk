import { useEffect, useMemo, useRef, useState } from 'react';
import { update, useApp } from '../lib/db.ts';
import type { Admin, EventMarketing, Store, TournamentEvent } from '../lib/types.ts';
import {
  campaignIssues,
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

/** What is kept on the campaign: trimmed, and nothing for an empty box. */
function tidy(m: EventMarketing): EventMarketing {
  const out: EventMarketing = {};
  for (const k of FIELDS) {
    const v = (m[k] ?? '').trim();
    if (v) out[k] = v;
  }
  return out;
}

/** HQ: this weekend's and next weekend's tournaments as a Discord post per campaign and a WhatsApp promo per store. Field admins never get here (App.tsx). */
export function MarketingPage() {
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const today = todayLocal();
  const weekends = useMemo(() => marketingWeekends({ events, stores }, today), [events, stores, today]);

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
        const next = tidy(draft);
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
      <PageHead kicker="HQ" title="Marketing." deck="This weekend’s tournaments, written out for Discord, WhatsApp and the players. Copy the Discord post, send each store its promo with the poster, and the night before, send each store’s players their message. Next weekend shows up here on Monday." />
      {weekends.length === 0 ? (
        <EmptyCard mark="team" title="No tournaments this weekend." hint="Stores playing this weekend show up here; next weekend’s join on Monday." />
      ) : (
        weekends.map((w) => (
          <section key={w.when} className="hs mk-weekend" aria-label={w.title}>
            <header className="hs-head">
              <h2>{w.title}</h2>
              <span className="label">{w.label}</span>
            </header>
            {w.campaigns.map((c) => (
              <Campaign key={c.event.id} event={c.event} stores={c.stores} opts={optsOf(c.event)} onEdit={(f, v) => edit(c.event, f, v)} />
            ))}
          </section>
        ))
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

      <details className="mk-settings" open={issues.length > 0}>
        <summary>
          Prize pool, times and texts
          {issues.map((i) => (
            <Chip key={i} tone="warn">
              {i}
            </Chip>
          ))}
        </summary>
        <div className="card mk-form">
          <div className="mk-grid">
            <Field label="Prize pool (₹)" value={opts.prizePool ?? ''} onChange={(v) => onEdit('prizePool', v)} placeholder={PRIZE_POOL} />
            <Field label="Reporting time" value={opts.reportingTime ?? ''} onChange={(v) => onEdit('reportingTime', v)} placeholder={REPORTING_TIME} />
            <Field label="First match" value={opts.firstMatch ?? ''} onChange={(v) => onEdit('firstMatch', v)} placeholder={FIRST_MATCH} />
          </div>
          <Field label="Discord intro" multiline value={opts.discordIntro ?? ''} onChange={(v) => onEdit('discordIntro', v)} placeholder={defaultDiscordIntro(game)} />
          <Field label="Discord closing" multiline value={opts.discordClosing ?? ''} onChange={(v) => onEdit('discordClosing', v)} placeholder={defaultDiscordClosing(game)} />
          <Field label="WhatsApp promo paragraph" multiline value={opts.whatsappIntro ?? ''} onChange={(v) => onEdit('whatsappIntro', v)} placeholder={defaultWhatsappIntro(game)} />
          <Field label="Discord invite (WhatsApp)" value={opts.discordInvite ?? ''} onChange={(v) => onEdit('discordInvite', v)} placeholder={DISCORD_INVITE} />
          <Field label="Players’ message: line under the date" value={opts.playerIntro ?? ''} onChange={(v) => onEdit('playerIntro', v)} placeholder={defaultPlayerIntro(game)} />
          <Field label="Tournament rules (players’ message)" multiline value={opts.rules ?? ''} onChange={(v) => onEdit('rules', v)} placeholder={defaultRules(game) || 'One rule per line, e.g. – Format: Single Elimination'} />
          <p className="mk-note">An empty box uses the grey text. Saved on the campaign a moment after you stop typing.</p>
        </div>
      </details>

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
        <ul className="mk-stores">
          {stores.map((s) => (
            <PlayerCard key={s.id} event={event} store={s} admins={admins} message={playerMessage(event, s, admins, opts)} short={storeShortName(s.name, names)} />
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

/** One store's night-before message to its players: the text and a Copy. */
function PlayerCard({ event, store, admins, message, short }: { event: TournamentEvent; store: Store; admins: Record<string, Admin>; message: string; short: string }) {
  const issues = playerIssues(store, admins);
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
      <pre className="mk-pre">{message}</pre>
      <div className="mk-actions">
        <button type="button" className="btn accent" onClick={() => void copyText(message, 'Players’ message')}>
          Copy message
        </button>
      </div>
    </li>
  );
}
