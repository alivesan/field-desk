import { useState } from 'react';
import { getState, sendCommand, useSync } from '../lib/db.ts';
import { applyCommand, dayVersion, type Command, type CommandContext } from '../lib/commands.ts';
import { copyText, csvRows, FILTER_LABEL, filterOnSpot, isAdded, onSpotCounts, onSpotOf, onSpotStates, prettyPhone, toCsv, type OnSpotFilter, type OnSpotState } from '../lib/onspot.ts';
import type { OnSpotEntry, Store, TournamentEvent } from '../lib/types.ts';
import { cx, downloadBlob, fmtDate, fmtTime, slug, todayLocal } from '../lib/util.ts';
import { askConfirm, Chip } from './ui.tsx';
import { useHqCommand } from './hqCommand.ts';
import '../styles/onspot.css';

/*
 * HQ: the walk-ins admins registered at the desk (day.onSpot, added by players.onspot), across a
 * campaign's stores (grouped by store) or for one store. HQ copies them into the store's
 * tournament on Toornament, ticks each one off (onspot.mark, HQ-only), and after a Refresh from
 * Toornament sees "In bracket" — the proof the round trip worked. HQ can also delete registrations
 * (onspot.remove — test data, mistakes): the record only, or with "also take them off the player
 * list" the players too. Pure logic: src/lib/onspot.ts.
 */

/** onspot.mark for each entry, checked here first like the server will. Returns '' or what went wrong. */
export function useMarkOnSpot() {
  const sync = useSync();
  return (storeId: string, entryIds: string[], done: boolean): string => {
    for (const entryId of entryIds) {
      // Fresh each time: every command bumps the day version the next one is based on.
      const state = getState();
      const store = state.stores[storeId];
      const event = store && state.events[store.eventId];
      if (!store || !event) return 'That store isn’t loaded on this device.';
      const cmd: Command = { type: 'onspot.mark', base: dayVersion(store), entryId, done };
      const ctx: CommandContext = { commandId: 'hq-precheck', now: new Date().toISOString(), actor: { principal: sync.principal ?? 'super', name: sync.name ?? 'HQ', role: 'super' }, event };
      try {
        applyCommand(store, cmd, ctx);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      try {
        sendCommand(storeId, cmd);
      } catch (e) {
        return `Couldn’t queue this on the device: ${(e as Error).message}`;
      }
    }
    return '';
  };
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older / embedded browsers: the selection route, else the text is shown to copy by hand.
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    t.remove();
    return ok;
  }
}

const when = (iso: string) => (todayLocal(new Date(iso)) === todayLocal() ? fmtTime(iso) : `${fmtDate(iso, { day: 'numeric', month: 'short' })}, ${fmtTime(iso)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `single`: inside one store's page — no store headings. */
export function OnSpotList({ event, stores, single }: { event: TournamentEvent; stores: Store[]; single?: boolean }) {
  const [filter, setFilter] = useState<OnSpotFilter>('todo');
  const { total, todo } = onSpotCounts(stores);
  const shownStores = stores.filter((s) => filterOnSpot(onSpotOf(s.day), filter).length);
  const counts: Record<OnSpotFilter, number> = { todo, done: total - todo, all: total };

  const download = () => {
    const csv = toCsv(csvRows(stores, filter));
    const name = `on-spot-${slug(single ? stores[0].name : event.name)}-${filter === 'todo' ? 'to-add' : filter === 'done' ? 'added' : 'all'}-${todayLocal()}.csv`;
    downloadBlob(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), name); // BOM: Excel reads it as UTF-8
  };

  return (
    <section className={cx('hq-onspot', single && 'single')} id="on-spot">
      <div className="os-head">
        <h2>
          On-spot registrations <span className={cx('os-count', todo > 0 && 'os-due')}>{total ? (todo ? `${todo} to add` : 'all added') : ''}</span>
        </h2>
        {total > 0 && (
          <button className="btn ghost" disabled={!counts[filter]} onClick={download}>
            Download CSV
          </button>
        )}
      </div>
      <p className="hint">
        Walk-ins the admin registered at the desk on the day — not on your list. Add them to {single ? 'this store’s' : 'the store’s'} tournament on Toornament, tick them off here, then Refresh the bracket from Toornament (Players &amp; bracket → Bracket).
      </p>

      {!total ? (
        <p className="os-empty">None yet. When an admin adds a player at the desk, they show up here.</p>
      ) : (
        <>
          <div className="seg small os-tabs" role="tablist" aria-label="Show">
            {(['todo', 'done', 'all'] as OnSpotFilter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={cx(filter === f && 'on')} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]} <span className="os-n">{counts[f]}</span>
              </button>
            ))}
          </div>
          {shownStores.length ? (
            shownStores.map((s) => <StoreGroup key={s.id} store={s} filter={filter} single={!!single} />)
          ) : (
            <p className="os-empty">{filter === 'todo' ? 'Nothing to add — every walk-in is marked as added to Toornament.' : 'None marked as added to Toornament yet.'}</p>
          )}
        </>
      )}
    </section>
  );
}

function StoreGroup({ store, filter, single }: { store: Store; filter: OnSpotFilter; single: boolean }) {
  const mark = useMarkOnSpot();
  const send = useHqCommand();
  const [alsoPlayers, setAlsoPlayers] = useState(false); // remove: take the players off the list too
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [manual, setManual] = useState(''); // text to copy by hand when the browser won't
  const rows = filterOnSpot(onSpotStates(store.day), filter);
  const entries = rows.map((r) => r.entry);
  const open = entries.filter((e) => !isAdded(e));
  const all = onSpotOf(store.day);
  const left = all.filter((e) => !isAdded(e)).length;
  const withIgn = entries.some((e) => e.ign);

  const copy = async (use: 'name' | 'ign') => {
    const text = copyText(entries, use);
    const what = plural(entries.length, 'name') + (use === 'ign' ? ' (in-game name where given)' : '');
    if (await copyToClipboard(text)) {
      setManual('');
      setNote({ text: `Copied ${what} — one per line, ready to paste into Toornament’s participant list.` });
    } else {
      setManual(text);
      setNote({ text: 'This browser wouldn’t copy — select the names below and copy them.' });
    }
  };
  const set = (ids: string[], done: boolean) => {
    const problem = mark(store.id, ids, done);
    setNote(problem ? { text: problem, bad: true } : null);
  };
  const markAll = async () => {
    if (!open.length) return;
    if (await askConfirm(`Mark ${plural(open.length, 'on-spot player')} at ${store.name} as added to Toornament? Only do this once they’re in the tournament there.`, { ok: 'Mark as added' }))
      set(
        open.map((e) => e.id),
        true,
      );
  };

  /** What happens to the players, in words: the confirm dialog says it before anything is deleted. */
  const aftermath = (list: OnSpotState[]) => {
    const onList = list.filter((r) => r.player);
    if (!onList.length) return '';
    const many = list.length > 1;
    if (!alsoPlayers) return ` ${many ? 'Players who are on the list stay on it' : 'They stay on the player list'} — remove them there if you want them gone too.`;
    const checked = onList.filter((r) => r.checkedIn).length;
    return ` ${many ? `${plural(onList.length, 'player')} will` : 'They will'} also be taken off the player list${checked ? ` (${checked} checked in)` : ''}.`;
  };
  const remove = async (list: OnSpotState[]) => {
    if (!list.length) return;
    const who = list.length === 1 ? `${list[0].entry.name}’s on-spot registration` : `all ${list.length} on-spot registrations`;
    if (!(await askConfirm(`Delete ${who} at ${store.name}?${aftermath(list)} This can’t be undone.`, { ok: list.length === 1 ? 'Delete' : 'Delete all', danger: true }))) return;
    const problem = send(store.id, (s) => ({ type: 'onspot.remove', base: dayVersion(s), entryIds: list.map((r) => r.entry.id), ...(alsoPlayers ? { alsoPlayers: true as const } : {}) }));
    setNote(problem ? { text: problem, bad: true } : null);
  };

  return (
    <div className="os-store">
      <div className="os-store-head">
        {!single && (
          <h3>
            <a href={`#/store/${store.id}/players`}>{store.name}</a>
          </h3>
        )}
        <span className="label">
          {left ? `${left} to add` : 'All added'} · {plural(all.length, 'walk-in')}
          {store.toornament?.url && (
            <>
              {' · '}
              <a href={store.toornament.url} target="_blank" rel="noreferrer noopener">
                Open on Toornament ↗
              </a>
            </>
          )}
        </span>
      </div>
      <div className="os-actions">
        <button className="btn ghost" onClick={() => copy('name')}>
          Copy names
        </button>
        {withIgn && (
          <button className="btn ghost" title="The in-game name where the player gave one, else the name" onClick={() => copy('ign')}>
            Copy in-game names
          </button>
        )}
        {open.length > 0 && (
          <button className="btn" onClick={markAll}>
            Mark all as added{open.length > 1 ? ` (${open.length})` : ''}
          </button>
        )}
        <button className="btn danger os-remove-all" title="Delete these registrations" onClick={() => remove(rows)}>
          {rows.length === all.length ? 'Remove all' : 'Remove these'} ({rows.length})
        </button>
      </div>
      <label className="os-also">
        <input type="checkbox" checked={alsoPlayers} onChange={(e) => setAlsoPlayers(e.target.checked)} /> Also take them off the player list
      </label>
      {note && <p className={cx('os-note', note.bad && 'bad')}>{note.text}</p>}
      {manual && <textarea className="os-manual" readOnly rows={Math.min(8, entries.length + 1)} value={manual} onFocus={(e) => e.currentTarget.select()} />}
      <ol className="os-list">
        {rows.map((r) => (
          <Row key={r.entry.id} row={r} onMark={(done) => set([r.entry.id], done)} onRemove={() => remove([r])} />
        ))}
      </ol>
    </div>
  );
}

function Row({ row, onMark, onRemove }: { row: OnSpotState; onMark: (done: boolean) => void; onRemove: () => void }) {
  const e: OnSpotEntry = row.entry;
  return (
    <li className={cx('os-row', isAdded(e) && 'added')}>
      <span className="os-who">
        <span className="os-name">{e.name}</span>
        {e.ign && <span className="ign"> · {e.ign}</span>}
      </span>
      <span className={cx('os-phone', !e.phone && 'none')}>{e.phone ? prettyPhone(e.phone) : 'no phone'}</span>
      <span className="os-meta">
        <span>
          {when(e.at)}
          {e.by ? ` · by ${e.by}` : ''}
        </span>
        <span className="row tight">
          {!row.player ? (
            <Chip tone="muted">Not on the player list</Chip>
          ) : (
            <>
              <Chip tone={row.checkedIn ? 'ok' : 'muted'}>{row.checkedIn ? 'Checked in' : 'Not checked in'}</Chip>
              <Chip tone={row.inBracket ? 'ok' : 'warn'}>{row.inBracket ? 'In bracket' : 'Not in bracket yet'}</Chip>
            </>
          )}
        </span>
      </span>
      <span className="os-mark">
        {isAdded(e) ? (
          <>
            <span className="os-done">✓ Added {when(e.toornament!)}</span>{' '}
            <button className="link" onClick={() => onMark(false)}>
              Undo
            </button>
          </>
        ) : (
          <button className="btn ghost os-tick" onClick={() => onMark(true)}>
            Added to Toornament
          </button>
        )}
        <button className="os-remove" aria-label={`Delete ${e.name}’s registration`} title="Delete this registration" onClick={onRemove}>
          ×
        </button>
      </span>
    </li>
  );
}
