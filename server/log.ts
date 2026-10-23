/*
 * Structured logs: one JSON object per line on stdout/stderr, e.g.
 *   {"t":"2026-10-23T09:00:00.000Z","level":"error","event":"request-failed","route":"POST /api/batch","error":"…"}
 * Never pass cookies, codes, request bodies or headers in `fields` — callers log ids and counts only.
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export const consoleLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const silentLogger: Logger = () => {};

/** The loggable part of an error: message, code and a short stack — no request data. */
export function errorFields(e: unknown): Record<string, unknown> {
  if (!(e instanceof Error)) return { error: String(e) };
  return { error: e.message, errorName: e.name, errorCode: (e as { code?: unknown }).code, stack: e.stack?.split('\n').slice(1, 6).map((s) => s.trim()) };
}
