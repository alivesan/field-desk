import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Command } from '../src/lib/commands.ts';
import type { Store } from '../src/lib/types.ts';
import { buildToornamentJob, jobMatchId, type ToornamentJob, type ToornamentJobDraft } from '../src/lib/toornament-jobs.ts';
import { canonical } from './canonical.ts';
import { consoleLogger, type Logger } from './log.ts';

/*
 * The Toornament result queue, Field Desk's side (docs/toornament-jobs.md). The `toornament_jobs` table is created in
 * server/migrate.ts (TOORNAMENT_JOBS_DDL). This file makes jobs and reads them; the worker's routes (claim, heartbeat,
 * checkpoint, ack, lease expiry) and HQ's resolve route are built on the same store.
 *
 * Jobs are made inside the command's own SQLite transaction (onCommand is the `extra` of commit() in api.ts), so a result
 * and its job are saved together or not at all — if anything here throws, the command is not committed.
 *
 * Payloads hold names and ids only; nothing here logs them (log lines carry store, match and job ids and codes).
 */

export type JobState = 'pending' | 'claimed' | 'done' | 'failed' | 'needs-human' | 'cancelled';

/** One line of a job's history. Codes, ids and times only — never OTPs, cookies, passwords or page content. */
export interface HistoryEntry {
  at: string; // ISO
  state: JobState;
  code: string;
  attempt: number;
  workerId?: string;
}

/** A row of toornament_jobs as stored (payload and history still JSON text). Times are epoch milliseconds. */
export interface JobRow {
  id: string;
  store_id: string;
  entity_id: string;
  revision: number;
  state: JobState;
  payload: string;
  payload_hash: string;
  tournament_id: string;
  stage_id: string;
  created_at: number;
  updated_at: number;
  attempt: number;
  claim_token: string | null;
  worker_id: string | null;
  lease_until: number | null;
  checkpoint_at: number | null;
  next_attempt_at: number | null;
  code: string | null;
  history: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The hash a job carries: sha256 of the canonical JSON of its payload without jobId / payloadHash. */
export const payloadHashOf = (draft: ToornamentJobDraft) => sha256(canonical(draft));

/** The payload of a stored job, as the worker receives it (jobId and payloadHash included). */
export function jobOf(row: JobRow): ToornamentJob {
  return { ...(JSON.parse(row.payload) as ToornamentJobDraft), jobId: row.id, payloadHash: row.payload_hash };
}

/** The history of a row with one more line (the caller writes it back with the new state). */
export function withHistory(row: Pick<JobRow, 'history'>, entry: HistoryEntry): string {
  return JSON.stringify([...(JSON.parse(row.history) as HistoryEntry[]), entry]);
}

/** Commands that replace the whole match list, so every pending job of the old bracket is stale. */
const REPLACES_BRACKET = new Set<Command['type']>(['bracket.load', 'bracket.reset']);

export function createJobStore(db: DatabaseSync, now: () => number, log: Logger = consoleLogger) {
  const byId = db.prepare('SELECT * FROM toornament_jobs WHERE id = ?');
  const maxRev = db.prepare('SELECT COALESCE(MAX(revision), 0) AS r FROM toornament_jobs WHERE store_id = ? AND entity_id = ?');
  const newest = db.prepare("SELECT * FROM toornament_jobs WHERE store_id = ? AND entity_id = ? AND state != 'cancelled' ORDER BY revision DESC LIMIT 1");
  const insert = db.prepare(
    `INSERT INTO toornament_jobs (id, store_id, entity_id, revision, state, payload, payload_hash, tournament_id, stage_id, created_at, updated_at, attempt, history)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const pendingOf = db.prepare("SELECT * FROM toornament_jobs WHERE store_id = ? AND state = 'pending'");
  const cancel = db.prepare("UPDATE toornament_jobs SET state = 'cancelled', code = ?, updated_at = ?, next_attempt_at = NULL, history = ? WHERE id = ? AND state = 'pending'");

  /** A new job id: "tj_" and 16 random url-safe characters. */
  const newId = () => `tj_${randomBytes(12).toString('base64url')}`;

  return {
    /** One job by id. */
    get: (id: string) => byId.get(id) as JobRow | undefined,

    /** The highest revision made for this (store, match), cancelled ones included; 0 when none. */
    lastRevision: (storeId: string, entityId: string) => (maxRev.get(storeId, entityId) as { r: number }).r,

    /** The newest job of this match that isn't cancelled — what Field Desk last sent, as far as it knows. */
    latest: (storeId: string, entityId: string) => newest.get(storeId, entityId) as JobRow | undefined,

    /** Stores a new `pending` job made from `draft` (adds the id and hash); returns the job as the worker will get it. Throws on a clash of (store, match, revision). */
    add(draft: ToornamentJobDraft): ToornamentJob {
      const at = now();
      const id = newId();
      const hash = payloadHashOf(draft);
      const history: HistoryEntry[] = [{ at: new Date(at).toISOString(), state: 'pending', code: 'created', attempt: 0 }];
      insert.run(id, draft.storeId, draft.entityId, draft.revision, JSON.stringify(draft), hash, draft.tournamentId, draft.stageId, at, at, JSON.stringify(history));
      return { ...draft, jobId: id, payloadHash: hash };
    },

    /**
     * Cancels the store's `pending` jobs (code `superseded`, appended to their history): all of them, or only those whose
     * match is not among `keepMatchIds`. A `claimed` job keeps running — the worker's own checks catch a changed bracket.
     * Returns how many.
     */
    cancelPending(storeId: string, keepMatchIds?: Set<string>): number {
      const at = now();
      let n = 0;
      for (const row of pendingOf.all(storeId) as unknown as JobRow[]) {
        if (keepMatchIds?.has(row.entity_id)) continue;
        cancel.run('superseded', at, withHistory(row, { at: new Date(at).toISOString(), state: 'cancelled', code: 'superseded', attempt: row.attempt }), row.id);
        n++;
      }
      return n;
    },

    /**
     * Runs inside the command's transaction (commit()'s `extra`): the job a finished / undone match makes, and the
     * cancelling of jobs a replaced bracket leaves behind. Throws only if the database does — which rolls the command back.
     */
    onCommand(c: { before: Store; after: Store; cmd: Command; commandId: string; now: string }): void {
      const storeId = c.after.id;
      // A bracket that no longer holds a match makes its pending jobs stale: all of them on load / reset, else those of matches that are gone.
      if (REPLACES_BRACKET.has(c.cmd.type)) {
        const n = this.cancelPending(storeId);
        if (n) log('info', 'toornament-jobs-superseded', { store: storeId, cancelled: n });
      } else if (c.before.day.matches.length) {
        const still = new Set(c.after.day.matches.map((m) => m.id));
        const n = this.cancelPending(storeId, still);
        if (n) log('info', 'toornament-jobs-superseded', { store: storeId, cancelled: n });
      }

      const matchId = jobMatchId(c.cmd);
      if (!matchId) return;
      const lastRevision = this.lastRevision(storeId, matchId);
      const last = this.latest(storeId, matchId);
      const made = buildToornamentJob({ ...c, lastRevision, last: last ? (JSON.parse(last.payload) as ToornamentJobDraft) : null });
      if (!made.job) {
        // Only the interesting refusals: a sync that is off is the normal case and not worth a line per match.
        if (made.reason !== 'sync-off' && made.reason !== 'bye') log('info', 'toornament-job-skipped', { store: storeId, match: matchId, reason: made.reason });
        return;
      }
      const job = this.add(made.job);
      log('info', 'toornament-job-made', { store: storeId, match: matchId, job: job.jobId, kind: job.kind, revision: job.revision });
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;
