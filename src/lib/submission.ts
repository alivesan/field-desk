/*
 * Recce submissions: the 'recce.submit' / 'recce.review' / 'recce.unreview' / 'recce.delete' / 'recce.reset' command
 * handlers, and the pure helpers the UI uses to say where a recce stands.
 *
 *   Draft            no submission yet, or the working recce differs from the latest one
 *   Waiting to send  a recce.submit command is still in this device's outbox
 *   Submitted · rev N  the server has it (it's in server-derived state, nothing pending)
 *   Reviewed         HQ approved that revision (the button says "Approve recce"; "Undo approval" is recce.unreview)
 *
 * A submission freezes a copy of the recce and the campaign requirements it was judged
 * against, so HQ can always reproduce exactly what it reviewed. The working recce stays
 * editable; changes after submitting show as "edited since rev N" until re-submitted.
 *
 * HQ can delete test data: recce.delete drops one revision (the working recce stays), recce.reset
 * drops them all and blanks the working recce. Photo files are write-once on the server and stay;
 * they're just no longer referenced. Revision numbers keep counting up past the highest one left.
 *
 * Handlers are pure (see commands.ts): ctx.now / ctx.commandId only — no clock, no random.
 * Node-loadable: no browser APIs, explicit .ts imports only.
 */
import type { Recce, Store, Submission, SubmissionPolicy } from './types.ts';
import { CommandError, type Command, type CommandContext, type Role } from './command-types.ts';
import { ensureRecce } from './recce.ts';

export const SUBMISSION_COMMANDS: Record<string, Role[]> = {
  'recce.submit': ['super', 'admin'],
  'recce.review': ['super'],
  'recce.unreview': ['super'],
  'recce.delete': ['super'],
  'recce.reset': ['super'],
};

/** A recce nobody has touched — the server-side twin of newRecce() in db.ts (a test keeps them equal). */
export function blankRecce(): Recce {
  return {
    status: 'draft',
    venue: { photos: [] },
    laptops: [],
    network: { wifi: null, lan: null, speed: null, photos: [] },
    furniture: { setup: null, chairType: '', chairCount: null, tablecloth: null, photos: [] },
    collateral: { posters: false, standee: false, cheque: false, standeePhotos: [], chequePhotos: [], chequeInStandeePhoto: false },
    summary: '',
  };
}

// Same as submissionVersion() in commands.ts — repeated here because commands.ts imports this file.
const version = (store: Store) => store.submissions?.length ?? 0;

/** The submission id a recce.submit command creates — derived from the command id, so a retry or an optimistic replay names the same revision. */
export const submissionIdFor = (commandId: string) => `sub-${commandId}`;

export function submissionCommand(store: Store, cmd: Command, ctx: CommandContext): Store {
  switch (cmd.type) {
    case 'recce.submit': {
      const id = submissionIdFor(ctx.commandId);
      if (store.submissions?.some((s) => s.id === id)) return store; // already applied (retry / replay)
      if (cmd.base !== version(store)) throw new CommandError('conflict', `The recce was submitted from another device in the meantime (rev ${version(store)}) — check it and submit again`);
      if (!store.recce || typeof store.recce !== 'object') throw new CommandError('invalid', 'This store has no recce to submit');
      const next = structuredClone(store);
      const frozen = ensureRecce(structuredClone(store.recce));
      frozen.status = 'submitted';
      frozen.submittedAt = ctx.now;
      const sub: Submission = {
        id,
        rev: (store.submissions ?? []).reduce((n, s) => Math.max(n, s.rev), 0) + 1, // not length+1: HQ may have deleted a middle revision
        submittedAt: ctx.now,
        by: ctx.actor.principal,
        byName: ctx.actor.name,
        recce: frozen,
        policy: { games: [...(ctx.event.games ?? [])], gameReadyTarget: ctx.event.gameReadyTarget, minDownMbps: ctx.event.minDownMbps },
      };
      next.submissions = [...(next.submissions ?? []), sub];
      // Legacy fields, for older clients and code that still reads them.
      ensureRecce(next.recce);
      next.recce.status = 'submitted';
      next.recce.submittedAt = ctx.now;
      return next;
    }
    case 'recce.review': {
      // No base check: marking an older revision reviewed is still true after a newer one arrives.
      const i = store.submissions?.findIndex((s) => s.id === cmd.submissionId) ?? -1;
      if (i < 0) throw new CommandError('conflict', 'That submission isn’t on the server (yet)');
      if (store.submissions![i].reviewedAt) return store; // already reviewed — keep the first review
      const next = structuredClone(store);
      next.submissions![i] = { ...next.submissions![i], reviewedAt: ctx.now, reviewedBy: ctx.actor.name || ctx.actor.principal };
      return next;
    }
    case 'recce.unreview': {
      // Undo an approval. Idempotent: a revision that isn't approved (any more) stays as it is. The match-day gate
      // (gate.ts) closes again only if no other revision is approved and it isn't the event date yet.
      const i = store.submissions?.findIndex((s) => s.id === cmd.submissionId) ?? -1;
      if (i < 0) throw new CommandError('conflict', 'That submission isn’t on the server (yet)');
      if (!store.submissions![i].reviewedAt) return store;
      const next = structuredClone(store);
      const { reviewedAt: _at, reviewedBy: _by, ...rest } = next.submissions![i];
      next.submissions![i] = rest;
      return next;
    }
    case 'recce.delete': {
      // No base check, like review: removing a revision is still what HQ meant when a newer one arrives.
      const i = store.submissions?.findIndex((s) => s.id === cmd.submissionId) ?? -1;
      if (i < 0) throw new CommandError('conflict', 'That revision isn’t on the server any more — it was already deleted, or never arrived.');
      const next = structuredClone(store);
      next.submissions = next.submissions!.filter((s) => s.id !== cmd.submissionId);
      // The legacy fields on the working recce must not leave a phantom "submitted" report behind (see submissionsOf).
      const last = next.submissions.at(-1);
      if (last) next.recce.submittedAt = last.submittedAt;
      else {
        next.recce.status = 'draft';
        delete next.recce.submittedAt;
      }
      return next;
    }
    case 'recce.reset': {
      // Destructive: HQ must have seen the revisions it is deleting.
      if (cmd.base !== version(store)) throw new CommandError('conflict', `A new revision arrived since this page loaded (rev ${version(store)}) — look at it, then reset again.`);
      const next = structuredClone(store);
      next.submissions = [];
      next.recce = blankRecce();
      next.pin = null; // the provisional venue pin came from the first geotagged photo
      return next;
    }
    default:
      throw new CommandError('invalid', `${(cmd as { type: string }).type} is not a submission command`);
  }
}

/* ---------- reading submission state (UI) ---------- */

/** Submitted before revisions existed: the live recce is all there is. */
export interface LegacySubmission extends Omit<Submission, 'policy'> {
  legacy: true;
  policy?: undefined;
}
export type AnySubmission = Submission | LegacySubmission;

/** Every submitted revision, oldest first. A store submitted by an older version of the app shows one legacy entry (rev 0, live recce, current policy). */
export function submissionsOf(store: Store): AnySubmission[] {
  if (store.submissions?.length) return store.submissions;
  if (store.recce?.status === 'submitted' && store.recce.submittedAt)
    return [{ id: `legacy-${store.recce.submittedAt}`, rev: 0, submittedAt: store.recce.submittedAt, by: '', byName: store.admin || '', recce: store.recce, legacy: true }];
  return [];
}

export const latestSubmission = (store: Store): AnySubmission | undefined => submissionsOf(store).at(-1);

export const isLegacy = (s: AnySubmission | undefined): s is LegacySubmission => !!s && 'legacy' in s && s.legacy === true;

/** "rev 3", or "first report" for one submitted before revisions were tracked. */
export const revLabel = (s: AnySubmission) => (isLegacy(s) ? 'before revisions' : `rev ${s.rev}`);

/** The recce minus bookkeeping that changes on submit, normalised so legacy shapes compare equal. */
function content(r: Recce): unknown {
  const c = ensureRecce(structuredClone(r)) as Partial<Recce>;
  delete c.status;
  delete c.submittedAt;
  delete c.startedAt;
  return c;
}

/** Deep equality that ignores key order and treats undefined like a missing key (JSON semantics). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameJson(x, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Has the working recce changed since this submission? */
export const editedSince = (store: Store, sub: AnySubmission) => !isLegacy(sub) && !sameJson(content(store.recce), content(sub.recce));

/** What the UI needs of a pending-work entry (db.ts PendingWork). */
export interface PendingLike {
  id: string;
  kind: string;
  storeId?: string;
  cmd?: { type: string };
  state: 'queued' | 'sending' | 'failed' | 'conflict';
  error?: string;
}

export type SubmissionStateKind = 'draft' | 'waiting' | 'failed' | 'submitted' | 'reviewed';

export interface SubmissionState {
  kind: SubmissionStateKind;
  latest?: AnySubmission; // newest revision in the state we have (may be optimistic while waiting)
  acknowledged?: AnySubmission; // newest revision the server has confirmed
  edited: boolean; // working recce differs from `acknowledged`
  work?: PendingLike; // the pending / failed recce.submit
}

/**
 * Where this store's recce stands. `pending` = usePendingWork(store.id). While a submit is
 * still in the outbox its optimistic revision is already in `store.submissions`, so the
 * newest one is not counted as acknowledged until the work is gone.
 */
export function submissionState(store: Store, pending: PendingLike[]): SubmissionState {
  const subs = submissionsOf(store);
  const submits = pending.filter((w) => w.kind === 'cmd' && w.cmd?.type === 'recce.submit' && (w.storeId === undefined || w.storeId === store.id));
  const inFlight = submits.find((w) => w.state === 'queued' || w.state === 'sending');
  const failed = submits.find((w) => w.state === 'failed' || w.state === 'conflict');
  const optimistic = new Set(submits.map((w) => submissionIdFor(w.id)));
  const acknowledged = [...subs].reverse().find((s) => !optimistic.has(s.id));
  const latest = subs.at(-1);
  const edited = acknowledged ? editedSince(store, acknowledged) : true;
  if (inFlight) return { kind: 'waiting', latest, acknowledged, edited, work: inFlight };
  if (failed) return { kind: 'failed', latest, acknowledged, edited, work: failed };
  if (!acknowledged || edited) return { kind: 'draft', latest, acknowledged, edited };
  return { kind: acknowledged.reviewedAt ? 'reviewed' : 'submitted', latest, acknowledged, edited };
}

/** Short status words, as shown on chips and in the recce header. */
export function submissionLabel(st: SubmissionState): string {
  const a = st.acknowledged;
  switch (st.kind) {
    case 'waiting':
      return 'Waiting to send';
    case 'failed':
      return 'Not sent';
    case 'reviewed':
      return 'Recce approved ✓';
    case 'submitted':
      return isLegacy(a) ? 'Submitted' : `Submitted · ${revLabel(a!)}`;
    default:
      return a ? `Edited since ${revLabel(a)}` : 'Draft';
  }
}

/** The policy a revision is assessed with: its own frozen copy (legacy ones have none). */
export const submissionPolicy = (s: AnySubmission | undefined): SubmissionPolicy | undefined => (s && !isLegacy(s) ? s.policy : undefined);
