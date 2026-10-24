import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from './api.ts';
import { consoleLogger as log, errorFields } from './log.ts';

/*
 * Production server: the API plus the built app from dist/. Run `npm run build` first.
 *
 *   PORT              default 8080 (0 = any free port; the chosen one is logged)
 *   DATA_DIR          database + photos, default ./data — one server process per directory
 *   DIST_DIR          the built app, default ./dist
 *   SUPER_ADMIN_CODE  HQ's sign-in code (required)
 *   TOORNAMENT_AUTO   0 = don't check Toornament for the bracket on the event day (default: check; see server/toornament-auto.ts)
 *   EVENT_TZ          the time zone of the event day, default Asia/Kolkata
 *   plus the API's own settings: TRUST_PROXY, COOKIE_NAME, SESSION_DAYS_ADMIN, SESSION_DAYS_SUPER,
 *   MAX_PHOTO_MB, MAX_PHOTOS_PER_STORE (see server/api.ts)
 *
 * No request can take the process down: the whole listener is wrapped, malformed URLs get a
 * 400 and static-file read errors a 500.
 */

const port = Number(process.env.PORT ?? 8080);
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const superCode = process.env.SUPER_ADMIN_CODE?.trim();
const dist = path.resolve(process.env.DIST_DIR ?? 'dist');
const indexFile = path.join(dist, 'index.html');

if (!superCode) {
  console.error('Set SUPER_ADMIN_CODE — your own HQ sign-in code (use something long, 16+ characters).');
  process.exit(1);
}
if (superCode.length < 10) console.warn('SUPER_ADMIN_CODE is short — it unlocks everything, so use 10+ characters.');
if (!fs.existsSync(indexFile)) {
  console.error(`${indexFile} is missing — run \`npm run build\` first (or set DIST_DIR).`);
  process.exit(1);
}

let api: ReturnType<typeof createApi>;
try {
  api = createApi({ dataDir, superCode, toornamentAuto: { enabled: process.env.TOORNAMENT_AUTO?.trim() !== '0' } });
} catch (e) {
  log('error', 'startup-failed', errorFields(e));
  process.exit(1);
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function plain(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return plain(res, 400, 'Bad request');
  }
  if (rel.includes('\0')) return plain(res, 400, 'Bad request');
  let file = path.join(dist, rel);
  const stat = file.startsWith(dist + path.sep) ? await fs.promises.stat(file).catch(() => null) : null;
  if (!stat?.isFile()) file = indexFile; // client-side routes (/K7Q2, /hq…) get the app
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  const headers = {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, headers);
      stream.pipe(res);
      resolve();
    });
    stream.once('error', (e) => {
      log('error', 'static-read-failed', { file: path.relative(dist, file), ...errorFields(e) });
      if (!res.headersSent) plain(res, 500, 'Server error');
      else res.destroy();
      resolve();
    });
  });
}

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  if (await api.handle(req, res)) return;
  await serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  onRequest(req, res).catch((e) => {
    log('error', 'request-failed', { method: req.method, ...errorFields(e) });
    if (!res.headersSent) plain(res, 500, 'Server error');
    else res.destroy();
  });
});
server.on('clientError', (_e, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

// Last line of defence: log, don't die, on a stray rejected promise.
process.on('unhandledRejection', (e) => log('error', 'unhandled-rejection', errorFields(e)));

const shutdown = (signal: string) => {
  log('info', 'shutdown', { signal });
  server.close();
  server.closeAllConnections?.();
  api.close();
  process.exit(0);
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(port, () => {
  const actual = (server.address() as { port: number }).port;
  log('info', 'listening', { port: actual, url: `http://localhost:${actual}`, dataDir, dist });
});
