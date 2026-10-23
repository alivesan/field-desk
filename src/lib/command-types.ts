/*
 * Command types and errors — a leaf module (no imports of handlers) so tournament.ts and
 * submission.ts can import it without a cycle. Everything here is re-exported by commands.ts.
 */
import type { Player, TournamentEvent } from './types.ts';

export type Role = 'super' | 'admin';

export type Command =
  // tournament (src/lib/tournament.ts)
  | { type: 'bracket.load'; base: number; players: Player[]; pairs?: [string | null, string | null][] | null; stations?: number }
  | { type: 'bracket.reset'; base: number } // clears the bracket (matches) only — players and check-ins stay
  | { type: 'players.set'; base: number; players: Player[] } // replace the roster (0–256); clears an unstarted bracket
  | { type: 'players.seed'; base: number; order: string[] } // every player id, in seed order; clears an unstarted bracket
  | { type: 'bracket.build'; base: number; stations?: number; pairs?: [string | null, string | null][] | null } // from the saved seeds
  | { type: 'stations.set'; base: number; count: number }
  | { type: 'match.start'; base: number; matchId: string; station: number }
  | { type: 'match.finish'; base: number; matchId: string; winner: string; score?: string; walkover?: boolean }
  | { type: 'match.undo'; base: number; matchId: string }
  // Desk registration on the day (admin or HQ); never touches the bracket. sameName 'different': the
  // admin confirmed this is another person with a name already on the list → added as "Name (2)".
  | { type: 'players.onspot'; base: number; name: string; phone?: string; ign?: string; sameName?: 'different' }
  | { type: 'onspot.mark'; base: number; entryId: string; done: boolean } // HQ: added to Toornament (or not yet)
  // submissions (src/lib/submission.ts)
  | { type: 'recce.submit'; base: number }
  | { type: 'recce.review'; base: number; submissionId: string };

export type CommandType = Command['type'];

export interface CommandContext {
  commandId: string; // the outbox entry id — stable across retries
  now: string; // ISO; server time on the server, the command's creation time on the client
  actor: { principal: string; name: string; role: Role };
  event: TournamentEvent; // the store's campaign
}

export type CommandErrorCode = 'conflict' | 'invalid' | 'forbidden';

/** Thrown by handlers. conflict → 409 (state moved on; refresh and retry), invalid → 400, forbidden → 403. */
export class CommandError extends Error {
  code: CommandErrorCode;
  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CommandError';
  }
}
