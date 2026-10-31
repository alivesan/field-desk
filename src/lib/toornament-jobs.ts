/*
 * Toornament result jobs — the pure half (design: docs/toornament-jobs.md, contract: the automation's JOB-CONTRACT.md).
 * When a match is finished or undone here, and the store is set up for it, the server queues one immutable job that a
 * browser worker later carries out on toornament.com. This file decides *whether* a command makes a job and *what is
 * in it*; server/toornament-jobs.ts stores it (same SQLite transaction as the command) and adds the job id and hash.
 *
 * v1: results only (match.result / match.reset), W/L only — the desk records no scores — and a walkover is a forfeit.
 * Never a job for a bye. Nothing here reads the clock or random numbers: the caller passes the command id and time.
 *
 * Node-loadable: no browser APIs, no node: modules, explicit .ts imports only. (The payload hash is sha256, so it is
 * made on the server, over the draft this file returns.)
 */
import type { Match, Player, Store } from './types.ts';
import type { Command } from './command-types.ts';
import { parseToornamentLink } from './toornament.ts';
import { bracketOrigin } from './toornament-auto.ts';

export const JOB_SCHEMA_VERSION = 1;

export type JobKind = 'match.result' | 'match.reset';

/** One side of a match as Toornament holds it. Field Desk sends no scores, so `score` is always null. */
export interface JobSide {
  id: string;
  score: null;
  result: 'win' | 'loss' | null;
  forfeit: boolean;
}

/** The match as Field Desk last sent it: before any result `pending`, all sides null; after a result `completed`. */
export interface JobPrevious {
  status: 'pending' | 'completed';
  sides: [JobSide, JobSide];
}

export interface JobDesired {
  outcome: 'played' | 'forfeit';
  winnerId: string;
  forfeitingParticipantId?: string;
}

/** A job without `jobId` and `payloadHash` — what the hash is taken over. Every id is a string. */
export interface ToornamentJobDraft {
  schemaVersion: 1;
  origin: 'field-desk';
  sourceCommandId: string;
  createdAt: string; // ISO
  storeId: string;
  entityId: string; // the Field Desk match id
  bracketGenerationId: string; // store.toornament.loadId
  revision: number; // per (store, match), from 1
  expectedPreviousRevision: number; // 0 for the first
  kind: JobKind;
  tournamentId: string;
  stageId: string;
  expectedTournamentName: string;
  expectedStageName: string;
  matchId: string; // Toornament's node id
  publicNodeId: string; // the same id (the worker verifies it every time)
  mappingVerified: true;
  toornamentLabel: string; // "Match #1.1.2.1"
  participants: [{ id: string; name: string }, { id: string; name: string }]; // side a, side b
  expectedPrevious: JobPrevious;
  desired?: JobDesired; // absent for match.reset
}

export interface ToornamentJob extends ToornamentJobDraft {
  jobId: string; // tj_…
  payloadHash: string; // sha256 hex of the canonical JSON of the draft
}

/* ---------- why a match can't have a job ---------- */

export type BlockReason =
  | 'sync-off'
  | 'bye'
  | 'not-mapped:no-tournament'
  | 'not-mapped:no-stage'
  | 'not-mapped:no-load-id'
  | 'not-mapped:not-from-toornament'
  | 'not-mapped:no-match-id'
  | 'not-mapped:no-players'
  | 'not-mapped:no-participant-id';

/**
 * Why this match can't be sent to Toornament, or null when everything is in place (the store's sync is on, it has a
 * tournament and stage, its bracket came from Toornament, the match has its Toornament number and both players their
 * participant id). The check order is the order of the codes above; 'bye' is never a problem to fix.
 */
export function jobsBlockReason(store: Store, match: Match): BlockReason | null {
  const t = store.toornament;
  if (!t?.sync?.on) return 'sync-off';
  if (match.bye) return 'bye';
  const link = parseToornamentLink(t.url);
  if (typeof link === 'string') return 'not-mapped:no-tournament';
  if (!t.stageId) return 'not-mapped:no-stage';
  if (!t.loadId) return 'not-mapped:no-load-id';
  if (bracketOrigin(store) !== 'toornament') return 'not-mapped:not-from-toornament';
  if (!match.toornament?.id || !match.toornament.label) return 'not-mapped:no-match-id';
  if (!match.a || !match.b) return 'not-mapped:no-players';
  const byId = new Map(store.day.players.map((p) => [p.id, p]));
  if (!byId.get(match.a)?.toornamentId || !byId.get(match.b)?.toornamentId) return 'not-mapped:no-participant-id';
  return null;
}

/** For HQ's page: the reason in plain words. */
export const blockReasonText = (r: BlockReason): string =>
  ({
    'sync-off': 'Sending results to Toornament is off for this store.',
    bye: 'A bye — there is nothing to send.',
    'not-mapped:no-tournament': 'The store has no usable Toornament link.',
    'not-mapped:no-stage': 'No Toornament stage is chosen for this store — use the bracket from Toornament again.',
    'not-mapped:no-load-id': 'The bracket was not loaded from Toornament.',
    'not-mapped:not-from-toornament': 'The bracket here was built by hand, not loaded from Toornament.',
    'not-mapped:no-match-id': 'This match has no Toornament match number — add the Toornament match numbers.',
    'not-mapped:no-players': 'The match is still waiting for its players.',
    'not-mapped:no-participant-id': 'A player here was not matched to a Toornament participant — load the bracket from Toornament again.',
  })[r];

/* ---------- the job ---------- */

/** The match a command is about, when it can make a job (finish / undo); null for every other command. */
export const jobMatchId = (cmd: Command): string | null => (cmd.type === 'match.finish' || cmd.type === 'match.undo' ? cmd.matchId : null);

export interface BuildInput {
  /** The store before and after the command. */
  before: Store;
  after: Store;
  cmd: Command;
  commandId: string;
  now: string; // ISO
  /** The highest revision already made for this (store, match), cancelled ones included; 0 when none. */
  lastRevision: number;
  /** The payload of the newest job for this match that isn't cancelled, or null when there is none. */
  last: ToornamentJobDraft | null;
}

export type BuildResult = { job: ToornamentJobDraft; reason?: undefined } | { job: null; reason: string };

const skip = (reason: string): BuildResult => ({ job: null, reason });
const blank = (id: string): JobSide => ({ id, score: null, result: null, forfeit: false });

/** The match as Toornament holds it after the last job Field Desk sent for it: a result, else (none, or a reset) still pending. */
function previousOf(last: ToornamentJobDraft | null, ids: [string, string]): JobPrevious {
  const d = last?.kind === 'match.result' ? last.desired : undefined;
  if (!d) return { status: 'pending', sides: [blank(ids[0]), blank(ids[1])] };
  const side = (id: string): JobSide => ({ id, score: null, result: id === d.winnerId ? 'win' : 'loss', forfeit: id === d.forfeitingParticipantId });
  return { status: 'completed', sides: [side(ids[0]), side(ids[1])] };
}

/**
 * The job a command makes, or null with a short reason (also for commands that never make one: 'not-a-result').
 * match.finish (the match was not done before, is not a bye) → match.result; match.undo (it was done) → match.reset.
 * Everything in the match's mapping must be in place (jobsBlockReason).
 */
export function buildToornamentJob(i: BuildInput): BuildResult {
  const { cmd, before, after } = i;
  const matchId = jobMatchId(cmd);
  if (!matchId) return skip('not-a-result');
  const was = before.day.matches.find((m) => m.id === matchId);
  const now = after.day.matches.find((m) => m.id === matchId);
  if (!was || !now) return skip('no-match');
  if (was.bye) return skip('bye');
  if (cmd.type === 'match.finish' && (was.status === 'done' || now.status !== 'done' || !now.winner)) return skip('not-finished');
  if (cmd.type === 'match.undo' && (was.status !== 'done' || now.status === 'done')) return skip('not-finished');
  // The store as it is now (the command itself never changes the mapping); the match as it was played.
  const blocked = jobsBlockReason(after, was);
  if (blocked) return skip(blocked);

  const t = after.toornament!;
  const link = parseToornamentLink(t.url);
  if (typeof link === 'string' || !t.stageId || !t.loadId || !was.toornament || !was.a || !was.b) return skip('not-mapped'); // unreachable after the check above; keeps the types honest
  const player = (id: string) => after.day.players.find((p) => p.id === id) as Player & { toornamentId: string };
  const [pa, pb] = [player(was.a), player(was.b)];
  const participants: ToornamentJobDraft['participants'] = [
    { id: pa.toornamentId, name: pa.name },
    { id: pb.toornamentId, name: pb.name },
  ];

  const job: ToornamentJobDraft = {
    schemaVersion: JOB_SCHEMA_VERSION,
    origin: 'field-desk',
    sourceCommandId: i.commandId,
    createdAt: i.now,
    storeId: after.id,
    entityId: was.id,
    bracketGenerationId: t.loadId,
    revision: i.lastRevision + 1,
    expectedPreviousRevision: i.lastRevision,
    kind: cmd.type === 'match.finish' ? 'match.result' : 'match.reset',
    tournamentId: link.tournamentId,
    stageId: t.stageId,
    expectedTournamentName: t.tournamentName || after.name,
    expectedStageName: t.stageName ?? '',
    matchId: was.toornament.id,
    publicNodeId: was.toornament.id,
    mappingVerified: true,
    toornamentLabel: `Match #${was.toornament.label}`,
    participants,
    expectedPrevious: previousOf(i.last, [participants[0].id, participants[1].id]),
  };
  if (job.kind === 'match.result') {
    const winner = now.winner === was.a ? pa : pb;
    const loser = winner === pa ? pb : pa;
    job.desired = now.walkover ? { outcome: 'forfeit', winnerId: winner.toornamentId, forfeitingParticipantId: loser.toornamentId } : { outcome: 'played', winnerId: winner.toornamentId };
  }
  return { job };
}
