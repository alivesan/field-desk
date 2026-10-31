import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUPER } from './helpers/server.ts';

/* The production server (server/index.ts) serves the app for the player QR route /c/<token> and the live bracket /b/<token>. */

const root = path.resolve(import.meta.dirname, '..');

const get = (port: number, pathname: string) =>
  new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    });
    r.on('error', reject);
    r.end();
  });

test('production: /c/<token> and /b/<token> get index.html; the public API under them answers JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-prod-'));
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fake-app</title>');
  const child = spawn(process.execPath, [path.join(root, 'server/index.ts')], {
    env: { ...process.env, PORT: '0', DATA_DIR: path.join(tmp, 'data'), DIST_DIR: dist, SUPER_ADMIN_CODE: SUPER, COOKIE_NAME: 'fd_prod_test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
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
    for (const p of ['/c/abcDEF123_-abcdef0', '/c/abcDEF123_-abcdef0?from=qr', `/c/${'Z'.repeat(64)}`, '/b/abcDEF123_-abcdef0', '/b/abcDEF123_-abcdef0/', `/b/${'Z'.repeat(64)}`]) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.match(r.type, /text\/html/, p);
      assert.match(r.body, /fake-app/, p);
    }
    const api = await get(port, '/api/public/checkin/abcDEF123_-abcdef0');
    assert.equal(api.status, 404);
    assert.match(api.type, /application\/json/);
    assert.equal(JSON.parse(api.body).code, 'not-found');
    const bracket = await get(port, '/api/public/bracket/abcDEF123_-abcdef0');
    assert.equal(bracket.status, 404);
    assert.match(bracket.type, /application\/json/);
    assert.equal(JSON.parse(bracket.body).code, 'not-found');
  } finally {
    if (child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
  }
});
