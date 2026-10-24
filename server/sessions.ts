import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

/*
 * Server-side sessions (F22). The cookie carries a random id; the database stores only its
 * sha256, so a copied database or backup can't be replayed as a cookie. Each session records:
 *
 *   principal   "super", "admin:<id>" or "store:<id>" (a store team's shared code)
 *   fp          fingerprint of the code it signed in with (HMAC of the code) — when HQ rotates an
 *               admin's code, or SUPER_ADMIN_CODE changes, the fingerprint no longer matches and
 *               every session made with the old code stops working
 *   expires_at  absolute expiry (no sliding renewal); revoked_at set by sign-out
 *   name        a store team session's person ("Rhea"), typed once on that phone; null for everyone else
 *
 * Validity of the principal (admin still exists, code unchanged) is checked by the caller.
 */

export interface SessionRow {
  id_hash: string;
  principal: string;
  fp: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  revoked_at: number | null;
  name: string | null;
}

export const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
/** 32 random bytes, base64url: what the cookie holds. */
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function createSessions(db: DatabaseSync, now: () => number) {
  // Added after schema 2 shipped: a lazy, idempotent column (no schema bump, so the previous build still opens the database).
  if (!(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some((c) => c.name === 'name')) db.exec('ALTER TABLE sessions ADD COLUMN name TEXT');
  const insert = db.prepare('INSERT INTO sessions (id_hash, principal, fp, created_at, expires_at, last_seen, revoked_at, name) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)');
  const rename = db.prepare('UPDATE sessions SET name = ? WHERE id_hash = ? AND revoked_at IS NULL');
  const byHash = db.prepare('SELECT * FROM sessions WHERE id_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?');
  const revoke = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL');
  const revokeOthers = db.prepare('UPDATE sessions SET revoked_at = ? WHERE principal = ? AND revoked_at IS NULL AND fp != ?');
  const prune = db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?');

  return {
    create(principal: string, fp: string, ttlMs: number, name: string | null = null) {
      const raw = randomBytes(32).toString('base64url');
      const t = now();
      const hash = hashToken(raw);
      insert.run(hash, principal, fp, t, t + ttlMs, t, name);
      return { raw, hash, expiresAt: t + ttlMs };
    },
    /** The live (unrevoked, unexpired) session with this id hash. */
    find(hash: string): SessionRow | undefined {
      const row = byHash.get(hash) as SessionRow | undefined;
      if (!row || row.revoked_at !== null || row.expires_at <= now()) return undefined;
      // last_seen is informational; write it at most every few minutes
      if (now() - row.last_seen > 5 * 60000) touch.run(now(), hash);
      return row;
    },
    setName(hash: string, name: string) {
      rename.run(name, hash);
    },
    revoke(hash: string) {
      revoke.run(now(), hash);
    },
    /** Ends a principal's sessions made with any other code (fp '' = all of them) — so rotating back to an old code doesn't revive them. */
    revokeAllExcept(principal: string, fp: string) {
      revokeOthers.run(now(), principal, fp);
    },
    /** Drops sessions that ended more than a week ago. */
    prune() {
      const cutoff = now() - 7 * 864e5;
      prune.run(cutoff, cutoff);
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
