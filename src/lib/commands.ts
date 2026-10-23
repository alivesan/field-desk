/*
 * Domain commands — the only way to change a store's tournament state (players, matches,
 * stations) and its submission history. Shared by the server and the client:
 *
 *   server: POST /api/command { id, storeId, cmd } → applyCommand on the current store,
 *           inside the commit, with server time and the authenticated actor. Authoritative.
 *   client: the same applyCommand runs optimistically over the local view while the command
 *           waits in the outbox; if it no longer applies there, it is shown as a conflict.
 *
 * Handlers are pure: (store, cmd, ctx) → new store, or throw CommandError. They must not read
 * the clock or random numbers — use ctx.now and ctx.commandId (e.g. for deterministic ids), so
 * the optimistic result on a device matches what the server will commit.
 *
 * Keep this file free of browser APIs: it is imported by Node (server + tests).
 */
import type { Store } from './types.ts';
import { tournamentCommand, TOURNAMENT_COMMANDS } from './tournament.ts';
import { submissionCommand, SUBMISSION_COMMANDS } from './submission.ts';

export * from './command-types.ts';
import { CommandError, type Command, type CommandContext, type CommandType, type Role } from './command-types.ts';

/** Who may issue which command. Field admins only ever act on their own assigned stores (checked by the server). */
export const COMMAND_ROLES: Record<CommandType, Role[]> = {
  ...TOURNAMENT_COMMANDS,
  ...SUBMISSION_COMMANDS,
} as Record<CommandType, Role[]>;

export function applyCommand(store: Store, cmd: Command, ctx: CommandContext): Store {
  if (!COMMAND_ROLES[cmd.type]?.includes(ctx.actor.role)) throw new CommandError('forbidden', `${ctx.actor.role} can’t ${cmd.type}`);
  if (cmd.type in TOURNAMENT_COMMANDS) return tournamentCommand(store, cmd, ctx);
  if (cmd.type in SUBMISSION_COMMANDS) return submissionCommand(store, cmd, ctx);
  throw new CommandError('invalid', `Unknown command ${(cmd as { type: string }).type}`);
}

/** Shape check for a command arriving over the network. Handlers do the semantic checks. */
export function validateCommand(input: unknown): Command {
  const c = input as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new CommandError('invalid', 'command must be an object');
  if (typeof c.type !== 'string' || !(c.type in COMMAND_ROLES)) throw new CommandError('invalid', 'unknown command type');
  if (!Number.isInteger(c.base) || (c.base as number) < 0) throw new CommandError('invalid', 'command.base must be the tournament/submission version the device saw');
  const str = (k: string) => {
    if (typeof c[k] !== 'string' || !(c[k] as string).length || (c[k] as string).length > 200) throw new CommandError('invalid', `${k} must be a string`);
  };
  const int = (k: string, min: number, max: number) => {
    if (!Number.isInteger(c[k]) || (c[k] as number) < min || (c[k] as number) > max) throw new CommandError('invalid', `${k} must be a whole number ${min}–${max}`);
  };
  switch (c.type) {
    case 'match.start':
      str('matchId');
      int('station', 1, 64);
      break;
    case 'match.finish':
      str('matchId');
      str('winner');
      if (c.score !== undefined && (typeof c.score !== 'string' || c.score.length > 40)) throw new CommandError('invalid', 'score must be short text');
      if (c.walkover !== undefined && typeof c.walkover !== 'boolean') throw new CommandError('invalid', 'walkover must be true/false');
      break;
    case 'match.undo':
      str('matchId');
      break;
    case 'stations.set':
      int('count', 1, 64);
      break;
    case 'bracket.load':
      if (!Array.isArray(c.players) || c.players.length < 2 || c.players.length > 256) throw new CommandError('invalid', 'players must be a list of 2–256');
      if (c.stations !== undefined) int('stations', 1, 64);
      break;
    case 'players.set':
      if (!Array.isArray(c.players) || c.players.length > 256) throw new CommandError('invalid', 'players must be a list of up to 256');
      break;
    case 'players.seed':
      if (!Array.isArray(c.order) || c.order.length > 256 || c.order.some((x) => typeof x !== 'string')) throw new CommandError('invalid', 'order must be the list of player ids');
      break;
    case 'bracket.build':
      if (c.stations !== undefined) int('stations', 1, 64);
      if (c.pairs !== undefined && c.pairs !== null && !Array.isArray(c.pairs)) throw new CommandError('invalid', 'pairs must be a list');
      break;
    case 'players.onspot':
      str('name');
      for (const k of ['phone', 'ign'])
        if (c[k] !== undefined && (typeof c[k] !== 'string' || (c[k] as string).length > 200)) throw new CommandError('invalid', `${k} must be short text`);
      if (c.sameName !== undefined && c.sameName !== 'different') throw new CommandError('invalid', 'sameName must be "different"');
      break;
    case 'onspot.mark':
      str('entryId');
      if (typeof c.done !== 'boolean') throw new CommandError('invalid', 'done must be true/false');
      break;
    case 'onspot.remove':
      if (!Array.isArray(c.entryIds) || !c.entryIds.length || c.entryIds.length > 256 || c.entryIds.some((x) => typeof x !== 'string' || !x || x.length > 200))
        throw new CommandError('invalid', 'entryIds must be a list of 1–256 registration ids');
      if (c.alsoPlayers !== undefined && typeof c.alsoPlayers !== 'boolean') throw new CommandError('invalid', 'alsoPlayers must be true/false');
      break;
    case 'recce.review':
    case 'recce.delete':
      str('submissionId');
      break;
  }
  return c as unknown as Command;
}

/** The version a command's `base` is compared against. */
export const dayVersion = (store: Store) => store.day?.version ?? 0;
export const submissionVersion = (store: Store) => store.submissions?.length ?? 0;
