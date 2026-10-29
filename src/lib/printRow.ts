import { printSpecOf } from './print.ts';
import type { PrintRow } from './printShare.ts';
import type { PrintKind, TournamentEvent } from './types.ts';

/** A file's label, print size and copies for this campaign: HQ's instructions where it set them, else the defaults. */
export const printRow = (event: Pick<TournamentEvent, 'printSpec'>, kind: PrintKind): PrintRow => ({ kind, ...printSpecOf(event, kind) });
