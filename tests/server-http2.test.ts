import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../server/api.ts';
import { silentLogger } from '../server/log.ts';
import { SUPER } from './helpers/server.ts';

/*
 * Phones talk HTTP/2 to `npm run dev:phone` (https). HTTP/2 has no Host header — the host is the
 * :authority pseudo-header — so the same-origin check on writes must read that, or every sign-in
 * from a phone is "Cross-origin request refused".
 */

test('HTTP/2: same-origin writes (sign-in) work; other origins are still refused', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-test-'));
  const api = createApi({ log: silentLogger, dataDir, superCode: SUPER });
  const server = http2.createServer((q, r) => {
    api.handle(q as unknown as IncomingMessage, r as unknown as ServerResponse).then((handled) => {
      if (!handled) {
        r.writeHead(404);
        r.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = http2.connect(origin);
  const post = (from: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const s = client.request({ ':method': 'POST', ':path': '/api/login', origin: from, 'content-type': 'application/json' });
      let status = 0;
      let text = '';
      s.on('response', (h) => (status = Number(h[':status'])));
      s.on('data', (d) => (text += d));
      s.on('end', () => resolve({ status, body: text ? JSON.parse(text) : null }));
      s.on('error', reject);
      s.end(JSON.stringify({ code: SUPER }));
    });
  try {
    const ok = await post(origin);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.role, 'super');
    const evil = await post('https://evil.example');
    assert.equal(evil.status, 403);
    assert.match(evil.body.error, /Cross-origin/);
  } finally {
    client.close();
    server.close();
    api.close();
  }
});
