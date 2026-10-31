import { createHash, timingSafeEqual } from 'node:crypto';
import type { AckInput, AckStatus, ClaimIdentity } from './toornament-jobs.ts';

/*
 * The Toornament browser worker's side of the result queue — configuration and input checks (docs/toornament-jobs.md,
 * "The worker's routes"). The queue itself is server/toornament-jobs.ts; the routes are in server/api.ts.
 *
 *   FD_TOORNAMENT_JOBS_KEY   bearer token of the worker (scope `toornament-jobs:write`): the ONLY credential
 *                            /api/v1/toornament/worker/* accepts, and accepted nowhere else (the Steam key is not accepted
 *                            there either). Unset or blank = those routes answer 503 not_configured.
 *
 * Every check here is strict and returns the first problem as a short message that names the field, never its value.
 * Nothing in here logs anything.
 */

export interface ToornamentWorkerOptions {
  /** Bearer token of the worker (FD_TOORNAMENT_JOBS_KEY). */
  apiKey?: string;
}

/** Options first, then the environment; blank counts as unset. */
export function toornamentWorkerConfig(opts: ToornamentWorkerOptions, env: NodeJS.ProcessEnv = process.env): { apiKey: string | null } {
  const apiKey = (opts.apiKey !== undefined ? opts.apiKey : env.FD_TOORNAMENT_JOBS_KEY)?.trim() || '';
  return { apiKey: apiKey || null };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** `Authorization: Bearer <key>` against the configured key, in constant time (both sides hashed to equal length). */
export function workerBearerMatches(header: string | undefined, key: string): boolean {
  const m = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header) : null;
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]), sha256(key));
}

/** Largest request body the worker routes read. */
export const WORKER_BODY_MAX = 16 * 1024;
/** Most scopes one claim may ask for. */
export const MAX_SCOPES = 50;
/** Most remote ids one ack may carry. */
export const MAX_OBSERVED_IDS = 100;

const ID = /^[A-Za-z0-9_-]{1,64}$/; // Toornament tournament / stage ids are digit strings
const JOB_ID = /^tj_[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const WORKER_ID = /^[\x20-\x7e]{1,64}$/;
const REMOTE_ID = /^[\x21-\x7e]{1,200}$/;
/** The fixed codes: `lowercase-with-hyphens` (Field Desk's own), or the automation's `UPPER_SNAKE` (queue.mjs sends those). */
const CODE = /^(?:[a-z0-9-]{1,64}|[A-Z][A-Z0-9_]{0,63})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function workerIdOf(v: unknown): string | null {
  return typeof v === 'string' && WORKER_ID.test(v) && v.trim() !== '' ? v : null;
}

export function checkClaim(body: unknown): Checked<{ workerId: string; scopes: { tournamentId: string; stageId: string }[] }> {
  if (!isObject(body)) return bad('Send { workerId, scopes } as a JSON object.');
  const workerId = workerIdOf(body.workerId);
  if (!workerId) return bad('workerId must be 1–64 printable characters.');
  if (!Array.isArray(body.scopes) || body.scopes.length < 1 || body.scopes.length > MAX_SCOPES) return bad(`scopes must be a list of 1–${MAX_SCOPES} { tournamentId, stageId }.`);
  const scopes: { tournamentId: string; stageId: string }[] = [];
  for (const s of body.scopes) {
    if (!isObject(s) || typeof s.tournamentId !== 'string' || !ID.test(s.tournamentId) || typeof s.stageId !== 'string' || !ID.test(s.stageId)) return bad('Each scope needs a tournamentId and a stageId (strings of letters, digits, _ or -, up to 64).');
    scopes.push({ tournamentId: s.tournamentId, stageId: s.stageId });
  }
  return { ok: true, value: { workerId, scopes } };
}

/** { jobId, payloadHash, revision, claimToken, workerId } — what heartbeat, checkpoint and ack all start with. */
export function checkIdentity(body: unknown): Checked<ClaimIdentity> {
  if (!isObject(body)) return bad('Send the job identity as a JSON object.');
  if (typeof body.jobId !== 'string' || !JOB_ID.test(body.jobId)) return bad('jobId is not a job id.');
  if (typeof body.payloadHash !== 'string' || !HASH.test(body.payloadHash)) return bad('payloadHash must be 64 lowercase hex characters.');
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) return bad('revision must be a whole number from 1.');
  if (typeof body.claimToken !== 'string' || !TOKEN.test(body.claimToken)) return bad('claimToken is not a claim token.');
  const workerId = workerIdOf(body.workerId);
  if (!workerId) return bad('workerId must be 1–64 printable characters.');
  return { ok: true, value: { jobId: body.jobId, payloadHash: body.payloadHash, revision: body.revision as number, claimToken: body.claimToken, workerId } };
}

export function checkCheckpoint(body: unknown): Checked<ClaimIdentity> {
  const id = checkIdentity(body);
  if (!id.ok) return id;
  if ((body as Record<string, unknown>).phase !== 'before-save') return bad('phase must be "before-save".');
  return id;
}

/**
 * Identity plus status, code and the optional nextAttemptAt / observedRemoteIds. `pending` is accepted for `retry` (the
 * automation's client reports a transient failure as status "pending").
 */
export function checkAck(body: unknown): Checked<{ id: ClaimIdentity; ack: AckInput }> {
  const id = checkIdentity(body);
  if (!id.ok) return id;
  const b = body as Record<string, unknown>;
  const status = b.status === 'pending' ? 'retry' : b.status;
  if (status !== 'done' && status !== 'failed' && status !== 'needs-human' && status !== 'retry') return bad('status must be done, failed, needs-human or retry.');
  if (typeof b.code !== 'string' || !CODE.test(b.code)) return bad('code must be a fixed code: lowercase letters, digits and hyphens (or UPPER_SNAKE), up to 64.');
  const ack: AckInput = { status: status as AckStatus, code: b.code };
  if (b.nextAttemptAt !== undefined && b.nextAttemptAt !== null) {
    if (typeof b.nextAttemptAt !== 'string' || !ISO_TIME.test(b.nextAttemptAt) || !Number.isFinite(Date.parse(b.nextAttemptAt))) return bad('nextAttemptAt must be an ISO time.');
    ack.nextAttemptAt = Date.parse(b.nextAttemptAt);
  }
  if (b.observedRemoteIds !== undefined && b.observedRemoteIds !== null) {
    if (!Array.isArray(b.observedRemoteIds) || b.observedRemoteIds.length > MAX_OBSERVED_IDS || b.observedRemoteIds.some((s) => typeof s !== 'string' || !REMOTE_ID.test(s))) {
      return bad(`observedRemoteIds must be a list of at most ${MAX_OBSERVED_IDS} short printable strings.`);
    }
    ack.observedRemoteIds = b.observedRemoteIds as string[];
  }
  return { ok: true, value: { id: id.value, ack } };
}
