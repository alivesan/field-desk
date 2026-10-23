/*
 * HQ's winners list — every store's winner and runner-up with the contact details the admin
 * collected (Store.day.winners), the date of the event, and a CSV of the lot for the final.
 * src/pages/WinnersPage.tsx is the page.
 *
 * Who won comes from the bracket (the final); the saved details are compared with it, so a record
 * whose final HQ has since reset shows as 'mismatch' instead of being trusted. A store whose final
 * is done but has nothing saved still shows who won, from the player list. One row per store per
 * place — a store without a final gets two empty rows.
 *
 * Node-loadable: no browser APIs, explicit .ts imports only.
 */
import type { AppState, Store, WinnerDetails } from './types.ts';
import { csvCell, localStamp, prettyPhone } from './onspot.ts';
import { storeDate } from './recce.ts';
import { FIELD_LABEL, finalResult, missingFields, type WinnerField } from './winnerInput.ts';

export type Place = 'Winner' | 'Runner-up';
export type WinnerStatus = 'complete' | 'partial' | 'no-details' | 'no-final' | 'mismatch';

export const STATUS_LABEL: Record<WinnerStatus, string> = {
  complete: 'Complete',
  partial: 'Partial',
  'no-details': 'No details saved',
  'no-final': 'Final not played',
  mismatch: 'Check — bracket changed',
};

export interface WinnerRow {
  eventId: string;
  campaign: string;
  storeId: string;
  store: string;
  city: string;
  state: string;
  date: string; // yyyy-mm-dd, the store's tournament day
  place: Place;
  realName: string;
  ign: string;
  phone: string; // normalized digits
  email: string;
  instagram: string; // handle without '@'
  status: WinnerStatus;
  missing: WinnerField[]; // partial only
  finalDone: boolean; // the bracket's final has been played
  listName: string; // the player-list name of who won / lost the final ('' when unknown)
  savedAt: string; // ISO, last saved ('' = nothing saved)
  savedBy: string;
  note: string; // mismatch: what no longer fits
}

type Person = Pick<WinnerRow, 'realName' | 'ign' | 'phone' | 'email' | 'instagram'>;
const nobody: Person = { realName: '', ign: '', phone: '', email: '', instagram: '' };
const saved = (d: WinnerDetails): Person => ({
  realName: d.realName?.trim() ?? '',
  ign: d.ign?.trim() ?? '',
  phone: d.phone?.trim() ?? '',
  email: d.email?.trim() ?? '',
  instagram: (d.instagram ?? '').trim().replace(/^@+/, ''),
});

/** Winner and runner-up rows for one store. */
export function storeWinnerRows(store: Store, event: { id: string; name: string; date: string }): WinnerRow[] {
  const { matches, players, winners } = store.day;
  const result = finalResult(matches);
  const places: [Place, string | undefined, WinnerDetails | undefined][] = [
    ['Winner', result?.winner, winners?.winner],
    ['Runner-up', result?.runnerUp, winners?.runnerUp],
  ];

  return places.map(([place, playerId, details]) => {
    const player = playerId ? players.find((p) => p.id === playerId) : undefined;
    const row: WinnerRow = {
      eventId: event.id,
      campaign: event.name,
      storeId: store.id,
      store: store.name,
      city: store.city,
      state: store.state ?? '',
      date: storeDate(store, event),
      place,
      ...nobody,
      status: 'no-final',
      missing: [],
      finalDone: !!result,
      listName: player?.name ?? '',
      savedAt: '',
      savedBy: '',
      note: '',
    };

    if (winners && details) {
      Object.assign(row, saved(details), { savedAt: winners.updatedAt, savedBy: winners.by });
      // Saved against a final that is no longer the bracket's: say so rather than trust it.
      const who = place === 'Winner' ? 'winner' : 'runner-up';
      const why = !result ? 'The bracket has no finished final now.' : winners.finalMatchId !== result.match.id ? 'The final is a different match now.' : details.playerId !== playerId ? `The ${who} is a different player now.` : '';
      if (why) return { ...row, status: 'mismatch', note: `${why} These details were saved earlier.` };
      const missing = missingFields(row);
      return { ...row, status: missing.length ? 'partial' : 'complete', missing };
    }

    if (!result) return row;
    // Final played, nothing saved: still show who it was, from the player list.
    return { ...row, status: 'no-details', realName: player?.name ?? '', ign: player?.ign ?? '', phone: player?.phone ?? '' };
  });
}

/** One row per store per place, sorted by event date, campaign, store (Winner before Runner-up). */
export function winnerRows(state: Pick<AppState, 'events' | 'stores'>, opts: { eventId?: string } = {}): WinnerRow[] {
  const rows: WinnerRow[] = [];
  for (const store of Object.values(state.stores)) {
    const event = state.events[store.eventId];
    if (!event || (opts.eventId && event.id !== opts.eventId)) continue;
    rows.push(...storeWinnerRows(store, event));
  }
  const rank = (r: WinnerRow) => (r.place === 'Winner' ? 0 : 1);
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.campaign.localeCompare(b.campaign) || a.store.localeCompare(b.store) || a.storeId.localeCompare(b.storeId) || rank(a) - rank(b));
}

export interface WinnerSummary {
  stores: number;
  played: number; // stores whose final has been played
  full: number; // stores where both winner and runner-up are complete
  check: number; // stores with a record that no longer matches the bracket
}

export function summarize(rows: WinnerRow[]): WinnerSummary {
  const by = new Map<string, WinnerRow[]>();
  for (const r of rows) by.set(r.storeId, [...(by.get(r.storeId) ?? []), r]);
  const stores = [...by.values()];
  return {
    stores: stores.length,
    played: stores.filter((s) => s[0].finalDone).length,
    full: stores.filter((s) => s.every((r) => r.status === 'complete')).length,
    check: stores.filter((s) => s.some((r) => r.status === 'mismatch')).length,
  };
}

/* ---------- CSV ---------- */

export const CSV_HEADER = ['Campaign', 'Store', 'City', 'State', 'Event date (yyyy-mm-dd)', 'Place', 'Real name', 'In-game name', 'Phone', 'Email', 'Instagram (@handle)', 'Status', 'Saved at', 'Saved by'];

/** The status as the CSV says it — the label, and for a partial one what's still missing. */
export const statusText = (r: Pick<WinnerRow, 'status' | 'missing'>) => (r.status === 'partial' ? `Partial — missing ${r.missing.map((f) => FIELD_LABEL[f]).join(', ')}` : STATUS_LABEL[r.status]);

/**
 * The CSV text, UTF-8 BOM first so Excel reads it as UTF-8. Cells are quoted when needed and
 * never read as a formula. Instagram is the bare handle: a leading "@" is a formula marker to a
 * spreadsheet, and the guard would turn it into a visible apostrophe.
 */
export function winnersCsv(rows: WinnerRow[]): string {
  const body = rows.map((r) => [r.campaign, r.store, r.city, r.state, r.date, r.place, r.realName, r.ign, prettyPhone(r.phone), r.email, r.instagram, statusText(r), localStamp(r.savedAt), r.savedBy]);
  return '﻿' + [CSV_HEADER, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
