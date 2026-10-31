/*
 * Command types and errors — a leaf module (no imports of handlers) so tournament.ts and
 * submission.ts can import it without a cycle. Everything here is re-exported by commands.ts.
 */
import type { Player, TournamentEvent } from './types.ts';

/** What the desk types for a winner / runner-up — who they are is taken from the final, not from here. */
export interface WinnerInput {
  realName: string;
  ign?: string;
  phone?: string;
  email?: string;
  instagram?: string;
}

export type Role = 'super' | 'admin';

export type Command =
  // tournament (src/lib/tournament.ts)
  | { type: 'bracket.load'; base: number; players: Player[]; pairs?: [string | null, string | null][] | null; stations?: number; toornament?: { round: number; index: number; id: string; label: string }[] } // toornament: the Toornament match at those positions of the bracket (src/lib/toornament.ts)
  | { type: 'bracket.label'; base: number; toornament: { round: number; index: number; id: string; label: string }[] } // HQ: sets only the Toornament match of existing matches — works with a bracket loaded before labels existed, and under way; nothing else changes
  | { type: 'bracket.reset'; base: number } // clears the bracket (matches) only — players and check-ins stay
  | { type: 'players.set'; base: number; players: Player[] } // replace the roster (0–256); clears an unstarted bracket
  | { type: 'players.seed'; base: number; order: string[] } // every player id, in seed order; clears an unstarted bracket
  | { type: 'bracket.build'; base: number; stations?: number; pairs?: [string | null, string | null][] | null } // from the saved seeds
  // HQ: put a player into a first-round slot (null = empty it) while that match hasn't been played; `base` must be current.
  // swap: the player already sits in another first-round slot — the two slots trade occupants (an empty target is fine)
  | { type: 'bracket.place'; base: number; matchId: string; side: 'a' | 'b'; playerId: string | null; swap?: true }
  | { type: 'stations.set'; base: number; count: number }
  | { type: 'match.start'; base: number; matchId: string; station: number }
  | { type: 'match.finish'; base: number; matchId: string; winner: string; score?: string; walkover?: boolean }
  | { type: 'match.undo'; base: number; matchId: string }
  // Desk registration on the day (admin or HQ); never touches the bracket. sameName 'different': the
  // admin confirmed this is another person with a name already on the list → added as "Name (2)".
  | { type: 'players.onspot'; base: number; name: string; phone?: string; ign?: string; sameName?: 'different' }
  // Change one player, bracket or not (never touches it). HQ: name, in-game name, number ('' removes the last two). Desk: only a number for a player who has none, and the in-game name. `base` is informational.
  | { type: 'players.edit'; base: number; playerId: string; name?: string; ign?: string; phone?: string }
  | { type: 'onspot.mark'; base: number; entryId: string; done: boolean } // HQ: added to Toornament (or not yet)
  // HQ deletes registrations (test data, mistakes). The players stay on the list unless alsoPlayers (refused once matches are under way).
  | { type: 'onspot.remove'; base: number; entryIds: string[]; alsoPlayers?: boolean }
  | { type: 'winners.set'; base: number; winner: WinnerInput; runnerUp: WinnerInput } // admin or HQ, once the final is done; who won comes from the final
  | { type: 'winners.manual'; base: number; winner: WinnerInput; runnerUp: WinnerInput } // HQ: type them by hand — a store whose bracket ran elsewhere; the runner-up may be left empty
  | { type: 'winners.clear'; base: number } // HQ: drop the saved winner + runner-up details (test data, or a final that was reset); the bracket stays
  // submissions (src/lib/submission.ts)
  | { type: 'recce.submit'; base: number }
  | { type: 'recce.review'; base: number; submissionId: string }
  | { type: 'recce.unreview'; base: number; submissionId: string } // HQ: take the approval of one revision back
  | { type: 'recce.delete'; base: number; submissionId: string } // HQ: drop one submitted revision; the working recce stays
  | { type: 'recce.reset'; base: number } // HQ: drop every revision and blank the working recce (base = revisions HQ saw)
  // the event is over (src/lib/done.ts): HQ marks a store finished by hand, or takes the mark back; `base` is informational
  | { type: 'event.finish'; base: number }
  | { type: 'event.reopen'; base: number };

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
