import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Command } from '../src/lib/commands.ts';
import type { Store } from '../src/lib/types.ts';
import { buildToornamentJob, jobMatchId, type ToornamentJob, type ToornamentJobDraft } from '../src/lib/toornament-jobs.ts';
import { canonical } from './canonical.ts';
import { consoleLogger, type Logger } from './log.ts';

/*
 * The Toornament result queue, Field Desk's side (docs/toornament-jobs.md). The `toornament_jobs` table is created in
 * server/migrate.ts (TOORNAMENT_JOBS_DDL). This file makes jobs and reads them, and holds the worker's side of the queue
 * (claim, heartbeat, checkpoint, ack, lease expiry — the HTTP routes are in server/api.ts, their input checks in
 * server/toornament-worker.ts); HQ's resolve route is built on the same store.
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
  /** Toornament ids the worker saw (ack only): short, printable, at most OBSERVED_MAX of them. */
  observedRemoteIds?: string[];
}

/** A claim lasts this long unless the worker's heartbeats extend it. */
export const LEASE_MS = 2 * 60_000;
/** A job is tried at most this many times (claims); a retry after the last one fails it: `too-many-attempts`. */
export const MAX_ATTEMPTS = 5;
/** The worker may ask for a retry at most this far ahead. */
export const MAX_RETRY_DELAY_MS = 60 * 60_000;
/** Ids kept in a history line: this many, each of at most OBSERVED_ID_MAX printable characters. */
export const OBSERVED_MAX = 10;
export const OBSERVED_ID_MAX = 40;
/**
 * History codes that mean an earlier attempt may have had an effect on Toornament (or was lost mid-way): a job claimed
 * again after one of these gets `recoveryRequired: true` — the worker then only reads, never saves. HQ's "Try again"
 * should add one of them (`retry-by-hq`) to the history of the job it puts back to `pending`.
 */
export const RECOVERY_CODES: ReadonlySet<string> = new Set(['checkpoint', 'lease-expired', 'lease-expired-after-checkpoint', 'retry-by-hq']);

/** Whether a job with this history needs the worker to reconcile before anything else. */
export const recoveryRequiredOf = (historyJson: string): boolean => (JSON.parse(historyJson) as HistoryEntry[]).some((h) => RECOVERY_CODES.has(h.code));

/** What the worker sent to identify its claim (every field is compared). */
export interface ClaimIdentity {
  jobId: string;
  payloadHash: string;
  revision: number;
  claimToken: string;
  workerId: string;
}

/** A refusal with a fixed code (the route answers it with `status` and `{ error: code }`). */
export type Refusal = { ok: false; status: 404 | 409; code: string };
export type AckStatus = 'done' | 'failed' | 'needs-human' | 'retry';
export interface AckInput {
  status: AckStatus;
  code: string;
  nextAttemptAt?: number;
  observedRemoteIds?: string[];
}
export interface ClaimResult {
  job: ToornamentJob;
  claimToken: string;
  attempt: number;
  recoveryRequired: boolean;
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

/**
 * `syncOn(storeId)` says whether the store's `toornament.sync.on` is true right now (read from the store documents); a
 * store with sync off has no job claimed. Left out, no store counts as on.
 */
export function createJobStore(db: DatabaseSync, now: () => number, log: Logger = consoleLogger, syncOn: (storeId: string) => boolean = () => false) {
  const byId = db.prepare('SELECT * FROM toornament_jobs WHERE id = ?');
  const maxRev = db.prepare('SELECT COALESCE(MAX(revision), 0) AS r FROM toornament_jobs WHERE store_id = ? AND entity_id = ?');
  const newest = db.prepare("SELECT * FROM toornament_jobs WHERE store_id = ? AND entity_id = ? AND state != 'cancelled' ORDER BY revision DESC LIMIT 1");
  const insert = db.prepare(
    `INSERT INTO toornament_jobs (id, store_id, entity_id, revision, state, payload, payload_hash, tournament_id, stage_id, created_at, updated_at, attempt, history)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const pendingOf = db.prepare("SELECT * FROM toornament_jobs WHERE store_id = ? AND state = 'pending'");
  const cancel = db.prepare("UPDATE toornament_jobs SET state = 'cancelled', code = ?, updated_at = ?, next_attempt_at = NULL, history = ? WHERE id = ? AND state = 'pending'");

  const expired = db.prepare("SELECT * FROM toornament_jobs WHERE state = 'claimed' AND lease_until <= ?");
  // Every write to a claimed job names the token it was claimed with, so a stale writer can't change a newer claim.
  const leave = db.prepare(
    `UPDATE toornament_jobs SET state = ?, code = ?, updated_at = ?, claim_token = NULL, lease_until = NULL, next_attempt_at = ?, history = ?
     WHERE id = ? AND state = 'claimed' AND claim_token = ?`,
  );
  const take = db.prepare(
    `UPDATE toornament_jobs SET state = 'claimed', code = 'claimed', updated_at = ?, attempt = ?, claim_token = ?, worker_id = ?, lease_until = ?,
       checkpoint_at = NULL, next_attempt_at = NULL, history = ?
     WHERE id = ? AND state = 'pending'`,
  );
  const giveUp = db.prepare("UPDATE toornament_jobs SET state = 'failed', code = 'too-many-attempts', updated_at = ?, next_attempt_at = NULL, history = ? WHERE id = ? AND state = 'pending'");
  const extend = db.prepare("UPDATE toornament_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_token = ?");
  const mark = db.prepare("UPDATE toornament_jobs SET checkpoint_at = ?, updated_at = ?, history = ? WHERE id = ? AND state = 'claimed' AND claim_token = ?");

  /** BEGIN IMMEDIATE … COMMIT: the whole of `fn` or nothing, and no other writer in between. */
  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const sameToken = (stored: string | null, given: string) => stored !== null && timingSafeEqual(digest(stored), digest(given));

  /** Claims whose lease ran out: back to `pending` (nothing was saved yet), or `needs-human` when the worker had reached its checkpoint. Call inside tx. */
  function expireInTx(): number {
    const at = now();
    const rows = expired.all(at) as unknown as JobRow[];
    for (const row of rows) {
      const state: JobState = row.checkpoint_at !== null ? 'needs-human' : 'pending';
      const code = row.checkpoint_at !== null ? 'lease-expired-after-checkpoint' : 'lease-expired';
      const entry: HistoryEntry = { at: iso(at), state, code, attempt: row.attempt, ...(row.worker_id ? { workerId: row.worker_id } : {}) };
      leave.run(state, code, at, null, withHistory(row, entry), row.id, row.claim_token ?? '');
      log('warn', 'toornament-job-lease-expired', { job: row.id, store: row.store_id, attempt: row.attempt, state, code });
    }
    return rows.length;
  }

  /** The job this identity names, if it is the current claim — else why not. Call inside tx, after expireInTx. */
  function claimedBy(id: ClaimIdentity): { ok: true; row: JobRow } | Refusal {
    const row = byId.get(id.jobId) as JobRow | undefined;
    if (!row) return { ok: false, status: 404, code: 'job_not_found' };
    if (row.state !== 'claimed') return { ok: false, status: 409, code: 'not_claimed' };
    if (!sameToken(row.claim_token, id.claimToken)) return { ok: false, status: 409, code: 'stale_token' };
    if (row.worker_id !== id.workerId) return { ok: false, status: 409, code: 'wrong_worker' };
    if (row.payload_hash !== id.payloadHash) return { ok: false, status: 409, code: 'wrong_hash' };
    if (row.revision !== id.revision) return { ok: false, status: 409, code: 'wrong_revision' };
    return { ok: true, row };
  }

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

    /** Runs the lease expiry now (a timer calls it every minute; claim, heartbeat, checkpoint and ack run it first). Returns how many leases ran out. */
    expireLeases: (): number => tx(expireInTx),

    /**
     * The oldest claimable job in one of `scopes`, claimed for `workerId`, or null. Claimable: `pending`, its store's sync on,
     * `next_attempt_at` passed, no job of the same stage `claimed`, no earlier revision of the same match still `pending`,
     * `claimed` or `needs-human`. Select and update are one BEGIN IMMEDIATE transaction, so two workers never get the same
     * job nor two jobs of one stage. A pending job that has used up its attempts is failed (`too-many-attempts`) instead.
     */
    claim(workerId: string, scopes: { tournamentId: string; stageId: string }[]): ClaimResult | null {
      if (!scopes.length) return null;
      const where = scopes.map(() => '(j.tournament_id = ? AND j.stage_id = ?)').join(' OR ');
      const select = db.prepare(
        `SELECT j.* FROM toornament_jobs j WHERE j.state = 'pending' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?) AND (${where})
           AND NOT EXISTS (SELECT 1 FROM toornament_jobs c WHERE c.tournament_id = j.tournament_id AND c.stage_id = j.stage_id AND c.state = 'claimed')
           AND NOT EXISTS (SELECT 1 FROM toornament_jobs e WHERE e.store_id = j.store_id AND e.entity_id = j.entity_id AND e.revision < j.revision
                           AND e.state IN ('pending', 'claimed', 'needs-human'))
         ORDER BY j.created_at, j.revision, j.rowid`,
      );
      return tx(() => {
        expireInTx();
        const at = now();
        const rows = select.all(at, ...scopes.flatMap((s) => [s.tournamentId, s.stageId])) as unknown as JobRow[];
        for (const row of rows) {
          if (!syncOn(row.store_id)) continue;
          if (row.attempt >= MAX_ATTEMPTS) {
            giveUp.run(at, withHistory(row, { at: iso(at), state: 'failed', code: 'too-many-attempts', attempt: row.attempt }), row.id);
            log('warn', 'toornament-job-failed', { job: row.id, store: row.store_id, code: 'too-many-attempts' });
            continue;
          }
          const claimToken = randomBytes(24).toString('base64url');
          const attempt = row.attempt + 1;
          const recoveryRequired = recoveryRequiredOf(row.history);
          take.run(at, attempt, claimToken, workerId, at + LEASE_MS, withHistory(row, { at: iso(at), state: 'claimed', code: 'claimed', attempt, workerId }), row.id);
          log('info', 'toornament-job-claimed', { job: row.id, store: row.store_id, match: row.entity_id, revision: row.revision, attempt, recoveryRequired });
          return { job: jobOf(row), claimToken, attempt, recoveryRequired };
        }
        return null;
      });
    },

    /** Extends the lease to 2 minutes from now. */
    heartbeat(id: ClaimIdentity): { ok: true; leaseUntil: number } | Refusal {
      return tx(() => {
        expireInTx();
        const c = claimedBy(id);
        if (!c.ok) return c;
        const leaseUntil = now() + LEASE_MS;
        extend.run(leaseUntil, now(), c.row.id, c.row.claim_token ?? '');
        return { ok: true, leaseUntil };
      });
    },

    /** Notes, durably, that this attempt may now change Toornament (the browser is about to save). Repeating it changes nothing. */
    checkpoint(id: ClaimIdentity): { ok: true } | Refusal {
      return tx(() => {
        expireInTx();
        const c = claimedBy(id);
        if (!c.ok) return c;
        if (c.row.checkpoint_at === null) {
          const at = now();
          mark.run(at, at, withHistory(c.row, { at: iso(at), state: 'claimed', code: 'checkpoint', attempt: c.row.attempt, workerId: id.workerId }), c.row.id, c.row.claim_token ?? '');
          log('info', 'toornament-job-checkpoint', { job: c.row.id, store: c.row.store_id, attempt: c.row.attempt });
        }
        return { ok: true };
      });
    },

    /**
     * The worker's report for its current claim. `retry` goes back to `pending` (at `nextAttemptAt`, else after a short
     * backoff) — refused once this attempt reached its checkpoint, and turned into `failed` (`too-many-attempts`) after the
     * last attempt. The new state is returned.
     */
    ack(id: ClaimIdentity, a: AckInput): { ok: true; state: JobState; code: string } | Refusal {
      return tx(() => {
        expireInTx();
        const c = claimedBy(id);
        if (!c.ok) return c;
        const row = c.row;
        const at = now();
        let state: JobState = a.status === 'retry' ? 'pending' : a.status;
        let code = a.code;
        let next: number | null = null;
        if (a.status === 'retry') {
          if (row.checkpoint_at !== null) return { ok: false, status: 409, code: 'checkpoint_reached' };
          if (row.attempt >= MAX_ATTEMPTS) {
            state = 'failed';
            code = 'too-many-attempts';
          } else next = Math.min(Math.max(a.nextAttemptAt ?? at + Math.min(60_000, 1000 * 2 ** (row.attempt - 1)), at), at + MAX_RETRY_DELAY_MS);
        }
        const seen = (a.observedRemoteIds ?? []).filter((s) => s.length <= OBSERVED_ID_MAX).slice(0, OBSERVED_MAX);
        const entry: HistoryEntry = { at: iso(at), state, code, attempt: row.attempt, workerId: id.workerId, ...(seen.length ? { observedRemoteIds: seen } : {}) };
        leave.run(state, code, at, next, withHistory(row, entry), row.id, row.claim_token ?? '');
        log('info', 'toornament-job-acked', { job: row.id, store: row.store_id, attempt: row.attempt, state, code });
        return { ok: true, state, code };
      });
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
