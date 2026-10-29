import { useEffect, useMemo, useState } from 'react';
import { sendCommand, updateStore, usePendingWork, useSync } from '../lib/db.ts';
import { applyCommand, dayVersion, type Command, type CommandContext } from '../lib/commands.ts';
import { maskPhone } from '../lib/phone.ts';
import { applyToornamentLink, toornamentBracketPage, toornamentLinkProblem, underWay, type ToornamentFetch } from '../lib/toornament.ts';
import { AUTO_EVERY_MIN, autoFinished, autoLine, planFor } from '../lib/toornament-auto.ts';
import type { Store, TournamentEvent } from '../lib/types.ts';
import { ago, cx } from '../lib/util.ts';
import { useMarkOnSpot } from './OnSpotList.tsx';
import { toast, useNow } from './ui.tsx';
import '../styles/toornament.css';
import '../styles/onspot.css';

/*
 * HQ, one store: fetch the store's bracket from Toornament (GET /api/toornament/fetch), preview
 * it against the store's players, and use it — one bracket.load { players, pairs } command, so
 * the roster and the bracket change together or not at all (refused if the store changed since
 * the preview, or once matches are under way). Names that match the store's players (ignoring
 * case and spacing) keep their id, phone and check-in; new names come in without a phone.
 * Walk-ins registered at the desk (day.onSpot) take part in the matching; those Toornament
 * doesn't have yet are named in the preview, and once the bracket is used HQ is offered to mark
 * the walk-ins it does have as added to Toornament (onspot.mark) — never done silently.
 * Self-contained: needs only the store and its campaign.
 */

type Fetched = { at: string; data: ToornamentFetch };

/*
 * The server also does this by itself: from 12:30 on the store's day it checks Toornament every 5
 * minutes and loads the bracket once the players are placed in it (server/toornament-auto.ts —
 * the same plan, the same bracket.load). The "Auto-check" line below shows how that is going, with
 * its switch; "Fetch from Toornament" stays for doing it by hand.
 */

const list = (names: string[]) => names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '');
const nPlayers = (n: number) => `${n} on-spot player${n === 1 ? '' : 's'}`;

/** The server's auto-check for this store: how it is going, its switch, and "Check again" once it has stopped for the day. */
export function AutoCheck({ store, event }: { store: Store; event: TournamentEvent }) {
  const now = new Date(useNow(30000));
  if (!store.toornament?.url) return null;
  const line = autoLine(store, event, now);
  // The switch and "Check again" write the HQ-only record; the server writes what it found into the same place.
  const set = (enabled: boolean) => updateStore(store.id, (s) => void (s.toornament && (s.toornament.auto = { enabled })));
  return (
    <div className={cx('tn-auto', line.tone)}>
      <p>{line.text}</p>
      <div className="row">
        <label className="tn-auto-switch">
          <input type="checkbox" checked={line.on} onChange={(e) => set(e.target.checked)} /> Check Toornament by itself every {AUTO_EVERY_MIN} min on the day
        </label>
        {line.on && autoFinished(store, now) && (
          <button className="link" onClick={() => set(true)}>
            Check again
          </button>
        )}
      </div>
    </div>
  );
}

export function ToornamentImport({ store, event }: { store: Store; event: TournamentEvent }) {
  const sync = useSync();
  const link = store.toornament?.url ?? '';
  const [editing, setEditing] = useState(!link);
  const [draft, setDraft] = useState(link);
  const [linkError, setLinkError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [got, setGot] = useState<Fetched | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  // After "Use": walk-ins in this bracket not yet marked as added to Toornament, offered to HQ.
  const [offer, setOffer] = useState<{ ids: string[]; names: string[]; done?: boolean; problem?: string } | null>(null);
  const mark = useMarkOnSpot();
  const work = usePendingWork(store.id);
  const sent = sentId ? work.find((w) => w.id === sentId) : undefined;

  // A link changed elsewhere (store details, another device): start over from it.
  useEffect(() => {
    setDraft(link);
    setEditing(!link);
    setGot(null);
    setError('');
  }, [link]);

  const fetchIt = async (stage?: string) => {
    if (!link) return;
    setBusy(true);
    setError('');
    setConfirming(false);
    setProblem('');
    try {
      const q = new URLSearchParams({ url: link });
      const s = stage ?? got?.data.stage?.id ?? store.toornament?.stageId;
      if (s) q.set('stage', s);
      const r = await fetch(`/api/toornament/fetch?${q}`);
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        // A stage that's gone: fetch again without it rather than getting stuck.
        if (r.status === 404 && s && !stage && body?.code === 'not-found' && /stage/i.test(body?.error ?? '')) {
          const q2 = new URLSearchParams({ url: link });
          const r2 = await fetch(`/api/toornament/fetch?${q2}`);
          const b2 = await r2.json().catch(() => null);
          if (r2.ok) return setGot({ at: new Date().toISOString(), data: b2 });
        }
        setError(r.status === 401 ? 'You’re signed out — sign in again, then fetch.' : (body?.error ?? `Toornament fetch failed (${r.status}).`));
        return;
      }
      setGot({ at: new Date().toISOString(), data: body as ToornamentFetch });
    } catch {
      setError('Couldn’t reach the Field Desk server — check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveLink = () => {
    const url = draft.trim();
    const p = toornamentLinkProblem(url);
    if (p) return setLinkError(p);
    updateStore(store.id, (s) => applyToornamentLink(s, url));
    setLinkError('');
    setEditing(!url);
  };

  const data = got?.data;
  const bracket = data?.bracket ?? null;
  const plan = useMemo(() => (bracket && bracket.players.length ? planFor(bracket, store, event) : null), [bracket, store, event]);
  const locked = underWay(store);
  const tooMany = !!bracket && bracket.players.length > 256;
  const canUse = !!plan && plan.players.length >= 2 && !tooMany && !locked;
  const nameOf = useMemo(() => new Map(plan?.players.map((p) => [p.id, p.name]) ?? []), [plan]);
  const matchedIds = useMemo(() => new Set(plan?.matched.map((p) => p.id) ?? []), [plan]);
  const walkInIds = useMemo(() => new Set(plan?.onSpotFound.map((f) => f.player.id) ?? []), [plan]);
  const keptIds = useMemo(() => new Set(plan?.onSpotMissing.flatMap((m) => (m.kept && m.player ? [m.player.id] : [])) ?? []), [plan]);
  const missing = plan?.onSpotMissing ?? [];
  const notYet = missing.filter((m) => !m.entry.toornament);
  const markedMissing = missing.filter((m) => m.entry.toornament);
  const leaving = missing.filter((m) => m.player && !m.kept);

  const use = () => {
    if (!plan || !data) return;
    setConfirming(false);
    setProblem('');
    const cmd: Command = { type: 'bracket.load', base: dayVersion(store), players: plan.players, pairs: plan.pairs };
    const ctx: CommandContext = { commandId: 'hq-precheck', now: new Date().toISOString(), actor: { principal: sync.principal ?? 'super', name: sync.name ?? 'HQ', role: 'super' }, event };
    try {
      applyCommand(store, cmd, ctx); // the same check the server makes, so a refusal shows here at once
    } catch (e) {
      return setProblem(e instanceof Error ? e.message : String(e));
    }
    let id: string;
    try {
      id = sendCommand(store.id, cmd);
      setSentId(id);
    } catch (e) {
      return setProblem(`Couldn’t queue this on the device: ${(e as Error).message}`);
    }
    toast('Bracket loaded from Toornament');
    const unmarked = plan.onSpotFound.filter((f) => !f.entry.toornament);
    setOffer(unmarked.length ? { ids: unmarked.map((f) => f.entry.id), names: unmarked.map((f) => f.entry.name) } : null);
    const at = new Date().toISOString();
    updateStore(store.id, (s) => {
      if (!s.toornament) return;
      s.toornament.stageId = data.stage?.id;
      s.toornament.stageName = data.stage?.name;
      s.toornament.appliedAt = at;
      s.toornament.by = sync.principal ?? 'super';
      s.toornament.loadId = id; // the bracket's match ids start with it — how the auto-check knows this one came from Toornament
    });
  };

  return (
    <section className="tn">
      <div className="tn-head">
        <div>
          <div className="label">From Toornament</div>
          {link && !editing ? (
            <p className="tn-link">
              {/* Open the bracket (…/stages/), not the registration page the sheet usually gives. */}
              <a href={toornamentBracketPage(link, store.toornament?.stageId)} target="_blank" rel="noreferrer noopener" title={link}>
                Open the bracket on Toornament ↗
              </a>{' '}
              <button className="link" onClick={() => setEditing(true)}>
                Change
              </button>
            </p>
          ) : (
            <p className="hint">No Toornament link for this store yet — paste it here or add it in the store details on the campaign page.</p>
          )}
          {store.toornament?.appliedAt && !editing && (
            <p className="hint">
              Last used {ago(store.toornament.appliedAt)}
              {store.toornament.stageName ? ` · stage “${store.toornament.stageName}”` : ''}.
            </p>
          )}
        </div>
        {link && !editing && (
          <button className="btn" disabled={busy} onClick={() => fetchIt()}>
            {busy ? 'Fetching…' : got ? 'Refresh' : 'Fetch from Toornament'}
          </button>
        )}
      </div>

      {link && !editing && <AutoCheck store={store} event={event} />}

      {editing && (
        <div className="tn-edit">
          <label className="field">
            <span className="label">Toornament link</span>
            <input
              type="url"
              value={draft}
              placeholder="https://play.toornament.com/en_US/tournaments/…/"
              onChange={(e) => {
                setDraft(e.target.value);
                setLinkError('');
              }}
            />
          </label>
          {linkError ? <p className="field-error">{linkError}</p> : <p className="hint">Open the tournament on toornament.com and copy the address bar. A stage page (…/stages/…) picks that stage.</p>}
          <div className="row">
            <button className="btn accent" disabled={draft.trim() === link} onClick={saveLink}>
              {draft.trim() || !link ? 'Save link' : 'Remove link'}
            </button>
            {link && (
              <button
                className="btn ghost"
                onClick={() => {
                  setDraft(link);
                  setEditing(false);
                  setLinkError('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="tn-error">{error}</p>}

      {data && (
        <div className="tn-result">
          <p className="tn-meta">
            <a href={data.stage ? `${data.tournament.page}stages/${data.stage.id}/` : data.tournament.page} target="_blank" rel="noreferrer noopener">
              <b>{data.tournament.name}</b>
            </a>
            {` · ${statusLabel(data.tournament.status)} · ${data.participantsTotal} registered · fetched ${ago(got!.at)}`}
          </p>

          {data.stages.length > 1 && (
            <label className="field tn-stage">
              <span className="label">Stage</span>
              <select value={data.stage?.id ?? ''} disabled={busy} onChange={(e) => fetchIt(e.target.value)}>
                {data.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.number}. {s.name} — {s.typeLabel}
                    {s.supported ? '' : ' (can’t be used)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {data.stage && data.stages.length === 1 && (
            <p className="hint">
              Stage: {data.stage.name} — {data.stage.typeLabel}, {statusLabel(data.stage.status)}
            </p>
          )}

          {!data.stage && <p className="tn-warn">This tournament has no stages on Toornament yet — add the bracket there, then Refresh.</p>}
          {data.stage && !data.stage.supported && <p className="tn-warn">{data.stage.reason}</p>}

          {bracket && (
            <>
              {bracket.problem && <p className="tn-warn">{bracket.problem}</p>}
              {tooMany && <p className="tn-warn">{bracket.players.length} players — a bracket here holds up to 256.</p>}
              {bracket.notes.length > 0 && (
                <ul className="tn-notes">
                  {bracket.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}

              {plan && (
                <div className="tn-preview">
                  <div className="tn-col">
                    <div className="label">
                      {plan.players.length} players · {plan.matched.length} on this store’s list · {plan.added.length} new
                    </div>
                    <ol className="tn-players">
                      {plan.players.map((p) => {
                        const kept = matchedIds.has(p.id);
                        return (
                          <li key={p.id}>
                            <span className="tn-seed">{p.seed}</span>
                            <span className="tn-name">
                              {p.name}
                              {p.ign && <small className="ign"> · {p.ign}</small>}
                              {(walkInIds.has(p.id) || keptIds.has(p.id)) && <span className="os-tag">On spot</span>}
                            </span>
                            <span className={cx('tn-tag', keptIds.has(p.id) ? '' : kept ? (p.phone ? 'ok' : '') : 'new')}>
                              {keptIds.has(p.id) ? 'kept · not in the bracket' : kept ? (p.phone ? `on list · ${maskPhone(p.phone)}` : 'on list · no phone') : 'new · no phone'}
                              {(kept || keptIds.has(p.id)) && store.day.checkIn[p.id] ? ' · checked in' : ''}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                    {plan.added.length > 0 && <p className="hint">New players have no phone number, so they check in at the desk, not by QR. Add their numbers in Players afterwards if you have them.</p>}
                    {notYet.length > 0 && (
                      <p className="tn-onspot os-warn">
                        <b>
                          {nPlayers(notYet.length)} {notYet.length === 1 ? 'isn’t' : 'aren’t'} on Toornament yet:
                        </b>{' '}
                        {list(notYet.map((m) => m.entry.name))} — add them there first, then Refresh.
                      </p>
                    )}
                    {markedMissing.length > 0 && (
                      <p className="tn-onspot os-warn">
                        <b>Marked as added but not in this bracket:</b> {list(markedMissing.map((m) => m.entry.name))} — check the stage and that the name (or in-game name) on Toornament is the same, then Refresh.
                      </p>
                    )}
                    {keptIds.size > 0 && <p className="hint">Until then they stay on the player list, outside the bracket (marked “kept” above).</p>}
                    {leaving.length > 0 && (
                      <p className="hint">
                        A bracket here holds only Toornament’s players, so using it now takes {leaving.length === 1 ? `${leaving[0].entry.name}` : `these ${leaving.length}`} off the player list. Their registration stays under On-spot registrations, and once they’re on Toornament a Refresh brings them back with their phone and in-game name (they check in again).
                      </p>
                    )}
                    {plan.dropped.length > 0 && (
                      <p className="tn-drop">
                        <b>Removed</b> — on this store’s list but not in Toornament’s bracket: {plan.dropped.map((p) => p.name).join(', ')}.
                      </p>
                    )}
                  </div>
                  <div className="tn-col">
                    <div className="label">{plan.pairs ? `First round · ${plan.pairs.length} matches` : 'First round'}</div>
                    {plan.pairs ? (
                      <ol className="tn-pairs">
                        {plan.pairs.map(([a, b], i) => (
                          <li key={i}>
                            <span className={cx(!a && 'bye')}>{a ? nameOf.get(a) : 'BYE'}</span>
                            <span className="tn-vs">vs</span>
                            <span className={cx(!b && 'bye')}>{b ? nameOf.get(b) : 'BYE'}</span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="hint">Not Toornament’s pairings: the bracket is drawn from this seed order the usual way (top seeds apart, any byes to the top seeds). You can re-seed afterwards.</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {locked && plan && <p className="tn-warn">Matches are already under way at this store — reset the bracket before replacing it.</p>}
          {problem && <p className="tn-error">{problem}</p>}

          {canUse &&
            (confirming ? (
              <div className="tn-confirm" role="alert">
                <span>
                  Replace this store’s players and bracket with these {plan!.players.length}?
                  {plan!.dropped.length ? ` ${plan!.dropped.length} removed.` : ''}
                  {leaving.length ? ` ${nPlayers(leaving.length)} not on Toornament leave the list for now.` : ''} Check-ins of players who stay are kept.
                </span>
                <button className="btn accent" onClick={use}>
                  Yes, use it
                </button>
                <button className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="row">
                <button className="btn accent" onClick={() => setConfirming(true)}>
                  {bracket?.mode === 'pairs' ? 'Use this bracket' : 'Use these players'}
                </button>
              </div>
            ))}
        </div>
      )}

      {sentId && (
        <p className={cx('tn-sent', sent && (sent.state === 'failed' || sent.state === 'conflict') && 'bad')}>
          {!sent
            ? 'Done — the bracket is built from Toornament.'
            : sent.state === 'failed' || sent.state === 'conflict'
              ? `Refused: ${sent.error ?? 'no reason given'}`
              : sync.connection === 'offline'
                ? 'Saved on this device — it’s sent when you’re back online.'
                : 'Sending…'}
        </p>
      )}
      {sentId && offer && !(sent && (sent.state === 'failed' || sent.state === 'conflict')) && (
        <div className="tn-onspot">
          {offer.done ? (
            `Marked ${nPlayers(offer.ids.length)} as added to Toornament.`
          ) : (
            <>
              {nPlayers(offer.ids.length)} in this bracket {offer.ids.length === 1 ? 'is' : 'are'} not marked as added to Toornament yet: {list(offer.names)}.
              <div>
                <button
                  className="btn"
                  onClick={() => {
                    const p = mark(store.id, offer.ids, true);
                    setOffer({ ...offer, done: !p, problem: p || undefined });
                  }}
                >
                  Mark {offer.ids.length} as added to Toornament
                </button>
              </div>
            </>
          )}
          {offer.problem && <p className="tn-error">{offer.problem}</p>}
        </div>
      )}
    </section>
  );
}

const statusLabel = (s: string) => (s === 'pending' ? 'not started' : s === 'running' ? 'in progress' : s === 'completed' ? 'finished' : s || 'status unknown');
