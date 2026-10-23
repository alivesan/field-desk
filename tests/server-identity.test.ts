import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedBasic } from './helpers/server.ts';

test('a request claiming a different principal than its session is refused (409 principal-mismatch)', async () => {
  const t = await startTestServer();
  try {
    await seedBasic(t);
    const a1 = await t.login('AAA2');
    const ok = await t.json('/api/state', { cookie: a1, headers: { 'X-Field-Desk-Principal': 'admin:a1' } });
    assert.equal(ok.status, 200);
    // The tab still thinks it is admin a2, but the cookie now belongs to a1.
    const r = await t.json('/api/batch', {
      method: 'POST',
      cookie: a1,
      headers: { 'X-Field-Desk-Principal': 'admin:a2' },
      body: { id: 'mismatch-0001', ops: [{ k: 'stores', id: 's1', p: ['recce', 'summary'], v: 'should not land' }] },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'principal-mismatch');
    const hq = await t.login('synthetic-hq-code-for-tests-0001');
    const st = await t.json('/api/state', { cookie: hq });
    assert.notEqual(st.body.stores.s1.recce.summary, 'should not land');
  } finally {
    await t.close();
  }
});

test('/api/me reports the current seq; the stream sends a named ping carrying it', async () => {
  const t = await startTestServer({ streamCheckMs: 50 });
  try {
    const hq = await seedBasic(t);
    const me = await t.json('/api/me', { cookie: hq });
    assert.equal(me.status, 200);
    assert.ok(Number.isInteger(me.body.seq) && me.body.seq >= 1, 'seq present');

    const text = await new Promise<string>((resolve, reject) => {
      const u = new URL(t.base + '/api/stream');
      const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Cookie: hq } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          if (/event: ping\ndata: \d+\n\n/.test(buf)) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
      setTimeout(() => reject(new Error('no ping within 2 s')), 2000).unref();
    });
    const seq = Number(text.match(/event: ping\ndata: (\d+)/)![1]);
    assert.equal(seq, me.body.seq);
  } finally {
    await t.close();
  }
});
