import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUPER } from './helpers/server.ts';

/* The production entry point (server/index.ts) as a real process, on temp data and a fake dist. */

const root = path.resolve(import.meta.dirname, '..');

async function startProd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-prod-'));
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fake</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  const child = spawn(process.execPath, [path.join(root, 'server/index.ts')], {
    env: { ...process.env, PORT: '0', DATA_DIR: path.join(tmp, 'data'), DIST_DIR: dist, SUPER_ADMIN_CODE: SUPER, COOKIE_NAME: 'fd_prod_test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stderr!.on('data', (d) => (out += d));
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/"event":"listening","port":(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { child, port, tmp, output: () => out };
}

/** A raw request, so the path reaches the server exactly as written. */
const raw = (port: number, pathname: string, method = 'GET') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject);
    r.end();
  });

const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });

test('F06: malformed percent-encoding gets a 400 and the server keeps serving', async () => {
  const s = await startProd();
  try {
    for (const bad of ['/%', '/%E0%A4%A', '/assets/%zz', '/api/%', '/api/photos/%E0%A4%A']) {
      const r = await raw(s.port, bad);
      assert.ok(r.status >= 400 && r.status < 500, `${bad} → ${r.status}`); // 400, or 401 for /api/ without a session
      assert.equal(s.child.exitCode, null, `process died on ${bad}`);
    }
    assert.equal((await raw(s.port, '/%')).status, 400);
    // still healthy
    const home = await raw(s.port, '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /fake/);
    assert.equal((await raw(s.port, '/K7Q2')).status, 200, 'client routes get the app');
    assert.equal((await raw(s.port, '/assets/app-abc.js')).body, 'console.log(1)');
    assert.equal((await raw(s.port, '/../../etc/passwd')).body.includes('fake'), true, 'no path traversal');
    assert.equal((await raw(s.port, '/', 'POST')).status, 405);
    assert.equal((await raw(s.port, '/api/me')).status, 200);
    assert.equal(s.child.exitCode, null);
  } finally {
    await stop(s.child);
  }
});

test('F06: a static file that fails to read gives a 500, not a crash', { skip: process.platform === 'win32' ? 'needs POSIX permissions' : undefined }, async () => {
  const s = await startProd();
  try {
    const f = path.join(s.tmp, 'dist', 'assets', 'locked.js');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o000);
    const r = await raw(s.port, '/assets/locked.js');
    if (process.getuid?.() === 0) assert.equal(r.status, 200); // root reads anyway
    else assert.equal(r.status, 500);
    assert.equal((await raw(s.port, '/')).status, 200);
  } finally {
    await stop(s.child);
  }
});

test('index: refuses to start without SUPER_ADMIN_CODE or dist, and when the data dir is locked', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-prod-'));
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [path.join(root, 'server/index.ts')], { env: { ...process.env, SUPER_ADMIN_CODE: '', PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout!.on('data', (d) => (out += d));
      c.stderr!.on('data', (d) => (out += d));
      c.once('exit', (code) => resolve({ code, out }));
    });
  let r = await run({ DATA_DIR: path.join(tmp, 'd') });
  assert.equal(r.code, 1);
  assert.match(r.out, /Set SUPER_ADMIN_CODE/);
  r = await run({ SUPER_ADMIN_CODE: SUPER, DIST_DIR: path.join(tmp, 'nodist'), DATA_DIR: path.join(tmp, 'd') });
  assert.equal(r.code, 1);
  assert.match(r.out, /missing/);

  const s = await startProd();
  try {
    r = await run({ SUPER_ADMIN_CODE: SUPER, DIST_DIR: path.join(s.tmp, 'dist'), DATA_DIR: path.join(s.tmp, 'data') });
    assert.equal(r.code, 1);
    assert.match(r.out, /startup-failed.*Another Field Desk server/);
  } finally {
    await stop(s.child);
  }
});
