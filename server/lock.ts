import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Single-instance lock: <dataDir>/.lock holds the owning process id. Documents and SSE
 * subscribers live in memory, so two server processes on one data directory would silently
 * overwrite each other's work — the second one refuses to start instead.
 *
 * The same process may take the lock again (Vite restarts its dev server in-process; a
 * container's server is always pid 1). A lock left by a process that is no longer running is
 * stale: it is replaced, with a log line saying so.
 */

export class LockError extends Error {}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

export function acquireLock(dataDir: string, onStale?: (info: string) => void): () => void {
  const file = path.join(dataDir, '.lock');
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return release(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let held: { pid?: unknown; host?: unknown; startedAt?: unknown } = {};
    try {
      held = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* unreadable or half-written: treat as stale */
    }
    const pid = Number(held.pid);
    if (pid === process.pid) {
      fs.writeFileSync(file, mine);
      return release(file);
    }
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      throw new LockError(
        `Another Field Desk server (pid ${pid}${held.host ? ` on ${held.host}` : ''}, started ${held.startedAt ?? '?'}) is using ${dataDir}. ` +
          `Stop it first. If you are sure no such process is running, delete ${file}.`,
      );
    }
    onStale?.(`Replacing a stale lock in ${dataDir} left by pid ${Number.isInteger(pid) ? pid : '?'} (not running).`);
    fs.rmSync(file, { force: true });
  }
  throw new LockError(`Couldn’t take the lock ${file}.`);
}

const held = new Set<string>();
let hooked = false;

function drop(file: string) {
  held.delete(file);
  try {
    if (Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

function release(file: string) {
  held.add(file);
  if (!hooked) {
    hooked = true;
    process.once('exit', () => [...held].forEach(drop));
  }
  return () => {
    if (held.has(file)) drop(file);
  };
}
