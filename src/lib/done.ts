/*
 * "Is it finished?" — a store's event, and a whole campaign. Pure and Node-loadable (the server
 * imports it through commands.ts).
 *
 *   Store finished   automatically, once the bracket's final has a winner AND the winner and
 *                    runner-up details are saved in full (a real name and a phone each, the same
 *                    test as the "Winners" step); or by hand, when HQ presses "Mark event finished"
 *                    (event.finish → store.finishedAt / finishedBy) for an event that ended some
 *                    other way. event.reopen clears the hand-made mark; a store that finished
 *                    automatically stays finished until its winner details or its final change.
 *                    If both are true the hand-made mark is the one reported.
 *   Campaign complete  every store of the campaign is finished, or HQ closed it by hand
 *                    (event.closedAt, a plain HQ-only field on the campaign). A campaign without
 *                    stores is only complete when closed.
 *
 * The two commands are HQ-only and idempotent; `base` is informational (like winners.clear).
 */
import type { Store, TournamentEvent } from './types.ts';
import { CommandError, type Command, type CommandContext, type Role } from './command-types.ts';
import { winnersState } from './winnerInput.ts';

export const FINISH_COMMANDS: Record<string, Role[]> = {
  'event.finish': ['super'],
  'event.reopen': ['super'],
};

export interface StoreFinished {
  finished: boolean;
  /** 'auto': the final is played and the winner details are saved. 'manual': HQ marked it. */
  how: 'auto' | 'manual' | null;
  /** When: HQ's mark, or the moment the winner details were saved. */
  at?: string;
  /** Who marked it (manual only). */
  by?: string;
}

/** `event` is the store's campaign; finishing is decided per store, so it is not needed yet. */
export function storeFinished(store: Store, _event?: TournamentEvent): StoreFinished {
  if (store.finishedAt) return { finished: true, how: 'manual', at: store.finishedAt, by: store.finishedBy };
  const ws = winnersState(store.day);
  if (ws.kind === 'saved' && !ws.missing) return { finished: true, how: 'auto', at: store.day.winners?.updatedAt };
  return { finished: false, how: null };
}

export interface CampaignComplete {
  complete: boolean;
  /** 'auto': every store is finished. 'manual': HQ closed the campaign. */
  how: 'auto' | 'manual' | null;
  /** When HQ closed it, or when the last store finished. */
  at?: string;
  finished: number;
  total: number;
}

/** `stores` are the campaign's; any other campaign's are ignored. */
export function campaignComplete(event: TournamentEvent, stores: Store[]): CampaignComplete {
  const mine = stores.filter((s) => s.eventId === event.id);
  const done = mine.map((s) => storeFinished(s, event));
  const finished = done.filter((d) => d.finished).length;
  const total = mine.length;
  if (event.closedAt) return { complete: true, how: 'manual', at: event.closedAt, finished, total };
  if (total > 0 && finished === total) {
    const times = done.map((d) => d.at).filter((t): t is string => !!t);
    return { complete: true, how: 'auto', at: times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : undefined, finished, total };
  }
  return { complete: false, how: null, finished, total };
}

/** Handlers for event.finish / event.reopen: pure, like every command (ctx.now only, no clock). */
export function finishCommand(store: Store, cmd: Command, ctx: CommandContext): Store {
  switch (cmd.type) {
    case 'event.finish': {
      if (store.finishedAt) return store; // already marked — keep the first mark
      return { ...store, finishedAt: ctx.now, finishedBy: ctx.actor.name || ctx.actor.principal };
    }
    case 'event.reopen': {
      if (!store.finishedAt) return store; // nothing to take back (an automatic finish isn't a mark)
      const { finishedAt: _at, finishedBy: _by, ...rest } = store;
      return rest;
    }
    default:
      throw new CommandError('invalid', `${(cmd as { type: string }).type} is not a finish command`);
  }
}
