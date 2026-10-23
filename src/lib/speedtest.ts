/* In-browser speed test against Cloudflare's public speed endpoints (CORS-enabled). */
import type { SpeedResult } from './types.ts';

const BASE = 'https://speed.cloudflare.com';
const PHASE_MS = 7000;
/** One request that takes longer than this is treated as failed. */
const REQUEST_MS = 10000;
/** The whole test gives up after this, whatever state it's in. */
const OVERALL_MS = 40000;

export type SpeedPhase = 'ping' | 'download' | 'upload' | 'done';
export interface SpeedProgress {
  phase: SpeedPhase;
  ping?: number;
  down?: number;
  up?: number;
  server?: string;
}

/* ---------- validation (pure — also used by the assessment) ---------- */

/** A download figure the checklist can count: a finite number ≥ 0. */
export const isMeasure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** True when a saved speed result actually carries a download measurement. */
export const hasDownload = (s: SpeedResult | null | undefined): s is SpeedResult & { down: number } => !!s && isMeasure(s.down);

export type SpeedField = 'down' | 'up' | 'ping';
export type ManualSpeedInput = Record<SpeedField, string>;
export type ManualSpeedCheck = { ok: true; value: Pick<SpeedResult, 'down' | 'up' | 'ping'> } | { ok: false; errors: Partial<Record<SpeedField, string>> };

const LIMITS: Record<SpeedField, number> = { down: 100000, up: 100000, ping: 60000 };

/**
 * Hand-typed speed (e.g. from fast.com): download is required, upload and ping optional;
 * every value given must be a finite number ≥ 0. Plain decimals only ("1,000" is rejected, not misread).
 */
export function parseManualSpeed(input: ManualSpeedInput): ManualSpeedCheck {
  const errors: Partial<Record<SpeedField, string>> = {};
  const value: Record<SpeedField, number | null> = { down: null, up: null, ping: null };
  for (const k of ['down', 'up', 'ping'] as const) {
    const raw = String(input[k] ?? '').trim();
    if (raw === '') {
      if (k === 'down') errors.down = 'Enter the download speed';
      continue;
    }
    // Number('') / Number(' ') are 0 and Number('0x10') is 16 — accept plain decimals only.
    const n = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(n)) errors[k] = 'Must be a number';
    else if (n < 0) errors[k] = 'Can’t be negative';
    else if (n > LIMITS[k]) errors[k] = `Too large — check the figure (max ${LIMITS[k]})`;
    else value[k] = Math.round(n * 10) / 10;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/* ---------- the test ---------- */

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mbps = (bytes: number, ms: number) => Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10;

/** A signal that aborts with the parent, or after `ms`. Call the returned `done` to release it. */
function child(parent: AbortSignal, ms: number) {
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (parent.aborted) c.abort();
  else parent.addEventListener('abort', onAbort);
  const timer = setTimeout(() => c.abort(), ms);
  return {
    signal: c.signal,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

class SpeedError extends Error {}

/**
 * Measures ping, download and upload. Resolves only with a real download figure; a failing
 * endpoint (HTTP error, no data, timeout) rejects instead of producing a "result". Upload is
 * best effort: some venue networks block large POSTs, so a failed upload leaves `up` unset.
 * Aborting `signal` (Stop button, or the component unmounting) rejects with an AbortError.
 */
export async function runSpeedTest(onProgress: (p: SpeedProgress) => void, signal: AbortSignal) {
  const overall = child(signal, OVERALL_MS);
  const all = overall.signal;
  const out: SpeedProgress = { phase: 'ping' };
  const tell = (p: Partial<SpeedProgress>) => {
    if (!all.aborted) onProgress(Object.assign(out, p));
  };
  const timedOut = () => all.aborted && !signal.aborted;

  try {
    // Latency: small requests, ignore the first (connection setup).
    const pings: number[] = [];
    for (let i = 0; i < 7; i++) {
      const req = child(all, REQUEST_MS);
      try {
        const t = performance.now();
        const r = await fetch(`${BASE}/__down?bytes=0&n=${Math.random()}`, { cache: 'no-store', signal: req.signal });
        if (!r.ok) throw new SpeedError(`Speed server answered ${r.status}`);
        await r.arrayBuffer();
        if (i === 0) out.server = r.headers.get('cf-meta-colo') ?? undefined;
        else pings.push(performance.now() - t);
      } finally {
        req.done();
      }
    }
    tell({ ping: Math.round(median(pings)) });

    // Download: stream large chunks for a fixed window, two connections in parallel.
    tell({ phase: 'download' });
    {
      let bytes = 0;
      let failure: string | null = null;
      const start = performance.now();
      const phase = child(all, PHASE_MS);
      const stream = async () => {
        while (!phase.signal.aborted) {
          const req = child(phase.signal, REQUEST_MS);
          try {
            const r = await fetch(`${BASE}/__down?bytes=50000000&n=${Math.random()}`, { cache: 'no-store', signal: req.signal });
            if (!r.ok || !r.body) {
              failure = `Speed server answered ${r.status}`;
              return;
            }
            const reader = r.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              tell({ down: mbps(bytes, performance.now() - start) });
            }
          } finally {
            req.done();
          }
        }
      };
      await Promise.allSettled([stream(), stream()]);
      phase.done();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timedOut()) throw new SpeedError('The speed test took too long');
      if (!bytes) throw new SpeedError(failure ?? 'No data came back from the speed server');
      tell({ down: mbps(bytes, performance.now() - start) });
    }

    // Upload: repeated POSTs of a random payload until the window closes. Best effort.
    tell({ phase: 'upload' });
    {
      const chunk = new Uint8Array(4_000_000);
      for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536));
      let bytes = 0;
      const start = performance.now();
      try {
        while (performance.now() - start < PHASE_MS) {
          const req = child(all, REQUEST_MS);
          try {
            const r = await fetch(`${BASE}/__up`, { method: 'POST', body: chunk, signal: req.signal, headers: { 'Content-Type': 'text/plain' } });
            if (!r.ok) throw new SpeedError(`upload ${r.status}`);
          } finally {
            req.done();
          }
          bytes += chunk.length;
          tell({ up: mbps(bytes, performance.now() - start) });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        if (!bytes) delete out.up; // no trustworthy upload figure
      }
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!isMeasure(out.down)) throw new SpeedError('No download figure was measured');
    tell({ phase: 'done' });
    return out;
  } catch (e) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut()) throw new SpeedError('The speed test took too long');
    throw e;
  } finally {
    overall.done();
  }
}
