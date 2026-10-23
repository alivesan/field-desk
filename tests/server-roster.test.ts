import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedBasic, type TestServer } from './helpers/server.ts';
import { fetchRoster, isBlockedAddress, sheetsCsvUrl, type HopResponse, type LookupAddress, type RosterFetchOptions } from '../server/roster-fetch.ts';

/*
 * GET /api/roster/fetch — HQ's roster link. The real https transport can't be pointed at a test
 * server, so tests inject a fake DNS (`lookup`) and a transport (`get`) that sends each hop to a
 * local http server, carrying the hostname in a header. Every rule under test (https only, the
 * address checks on each hop, redirects, size, type, Sheets links) lives in fetchRoster itself.
 */

const PUBLIC4 = { address: '93.184.215.14', family: 4 };
const DNS: Record<string, LookupAddress[]> = {
  'sheet.example': [PUBLIC4],
  'docs.google.com': [{ address: '142.250.183.14', family: 4 }],
  'accounts.google.com': [{ address: '142.250.183.45', family: 4 }],
  'internal.example': [{ address: '10.0.0.5', family: 4 }],
  'cgnat.example': [{ address: '100.64.1.1', family: 4 }],
  'mixed.example': [PUBLIC4, { address: 'fd00::1', family: 6 }],
  'mapped.example': [{ address: '::ffff:192.168.0.1', family: 6 }],
};
const lookup = async (host: string) => {
  const a = DNS[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return a;
};

const seen: string[] = []; // every URL the upstream was asked for
const CSV = 'name,phone\nAsha Rao,9820011111\n';

function upstream() {
  return http.createServer((req, res) => {
    const host = String(req.headers['x-host']);
    const u = new URL(req.url!, `https://${host}`);
    seen.push(u.href);
    const go = (loc: string, status = 302) => (res.writeHead(status, { Location: loc }), res.end());
    if (host === 'docs.google.com' && u.pathname === '/spreadsheets/d/PUBLIC_ID/export') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      return res.end(`﻿${CSV}`);
    }
    if (host === 'docs.google.com' && u.pathname === '/spreadsheets/d/PRIVATE_ID/export') return go('https://accounts.google.com/ServiceLogin?continue=x');
    switch (u.pathname) {
      case '/roster.csv':
        res.writeHead(200, { 'Content-Type': 'text/csv' });
        return res.end(CSV);
      case '/hop1':
        return go('/hop2', 301);
      case '/hop2':
        return go('https://sheet.example/roster.csv', 307);
      case '/to-private':
        return go('https://internal.example/secret');
      case '/to-literal':
        return go('https://127.0.0.1/secret');
      case '/to-v6':
        return go('https://[::1]/secret');
      case '/to-http':
        return go('http://sheet.example/roster.csv');
      case '/loop':
        return go('/loop');
      case '/no-location':
        res.writeHead(302);
        return res.end();
      case '/big-declared':
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Length': String(3 * 1024 * 1024) });
        return res.end();
      case '/big-chunked': {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); // no Content-Length: counted while streaming
        const chunk = 'x'.repeat(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 2 * 1024 * 1024 + 1) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once('drain', pump);
          }
          res.end();
        };
        res.on('error', () => {});
        return pump();
      }
      case '/exactly-2mb':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('y'.repeat(2 * 1024 * 1024));
      case '/image':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end('\x89PNG');
      case '/pdf':
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end('%PDF');
      case '/octet-text':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(CSV);
      case '/octet-binary':
        res.writeHead(200, { 'Content-Type': 'application/vnd.ms-excel' });
        return res.end(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0]));
      case '/html':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<table><tr><td>Asha</td></tr></table>');
      case '/500':
        res.writeHead(500);
        return res.end();
      case '/403':
        res.writeHead(403);
        return res.end();
      case '/slow':
        return; // never answers
      default:
        res.writeHead(404);
        return res.end();
    }
  });
}

async function setup() {
  const up = upstream();
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  const port = (up.address() as { port: number }).port;
  const get = async (url: URL, _addr: LookupAddress, signal: AbortSignal): Promise<HopResponse> => {
    const r = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { redirect: 'manual', signal, headers: { 'x-host': url.hostname.replace(/^\[|\]$/g, '') } });
    return {
      status: r.status,
      headers: Object.fromEntries(r.headers),
      body: (r.body ?? (async function* () {})()) as AsyncIterable<Uint8Array>,
      close: () => void r.body?.cancel().catch(() => {}),
    };
  };
  const rosterFetch: RosterFetchOptions = { lookup, get, timeoutMs: 1500 };
  const t = await startTestServer({ rosterFetch });
  const hq = await seedBasic(t);
  const a1 = await t.login('AAA2');
  const fetchVia = (link: string, cookie = hq) => t.json(`/api/roster/fetch?url=${encodeURIComponent(link)}`, { cookie });
  return {
    t,
    hq,
    a1,
    fetchVia,
    rosterFetch,
    close: async () => {
      up.closeAllConnections();
      up.close();
      await t.close();
    },
  };
}

const expectCode = async (p: Promise<{ status: number; body: any }>, status: number, code: string, label: string) => {
  const r = await p;
  assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, code, label);
  return r;
};

test('roster fetch: HQ only — field admins 403, no session 401', async () => {
  const s = await setup();
  try {
    await expectCode(s.fetchVia('https://sheet.example/roster.csv', s.a1), 403, 'forbidden', 'admin');
    assert.equal((await s.t.json(`/api/roster/fetch?url=${encodeURIComponent('https://sheet.example/roster.csv')}`)).status, 401);
  } finally {
    await s.close();
  }
});

test('roster fetch: a CSV link and its redirects come back as text with the final URL', async () => {
  const s = await setup();
  try {
    const r = await s.fetchVia('https://sheet.example/roster.csv');
    assert.equal(r.status, 200);
    assert.equal(r.body.url, 'https://sheet.example/roster.csv');
    assert.equal(r.body.contentType, 'text/csv');
    assert.equal(r.body.text, CSV);
    assert.ok(Date.parse(r.body.fetchedAt) > 0);
    const hop = await s.fetchVia('https://sheet.example/hop1');
    assert.equal(hop.status, 200);
    assert.equal(hop.body.url, 'https://sheet.example/roster.csv');
    const html = await s.fetchVia('https://sheet.example/html');
    assert.equal(html.status, 200, 'html allowed (Google serves some pages that way)');
    assert.match(html.body.contentType, /text\/html/);
    const oct = await s.fetchVia('https://sheet.example/octet-text');
    assert.equal(oct.status, 200, 'octet-stream that is really text');
    assert.equal(oct.body.text, CSV);
  } finally {
    await s.close();
  }
});

test('roster fetch: bad links → 400 bad-url (http, not a link, credentials, odd port)', async () => {
  const s = await setup();
  try {
    for (const link of ['http://sheet.example/roster.csv', 'not a link', '', 'ftp://sheet.example/x', 'https://user:pw@sheet.example/roster.csv', 'https://sheet.example:8443/roster.csv', 'javascript:alert(1)']) {
      await expectCode(s.fetchVia(link), 400, 'bad-url', link || '(empty)');
    }
  } finally {
    await s.close();
  }
});

test('roster fetch: loopback / private / CGNAT / mapped / mixed addresses → 400 blocked-host, before any request', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    for (const link of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://app.localhost/x',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://0.0.0.0/x',
      'https://169.254.169.254/latest/meta-data',
      'https://2130706433/x', // 127.0.0.1 as a number
      'https://internal.example/x',
      'https://cgnat.example/x',
      'https://mapped.example/x',
      'https://mixed.example/x',
    ]) {
      await expectCode(s.fetchVia(link), 400, 'blocked-host', link);
    }
    assert.deepEqual(seen, [], 'nothing was fetched');
  } finally {
    await s.close();
  }
});

test('roster fetch: every redirect hop is checked — to a private name, IP literal, IPv6 loopback, or http', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    await expectCode(s.fetchVia('https://sheet.example/to-private'), 400, 'blocked-host', 'redirect → private name');
    await expectCode(s.fetchVia('https://sheet.example/to-literal'), 400, 'blocked-host', 'redirect → 127.0.0.1');
    await expectCode(s.fetchVia('https://sheet.example/to-v6'), 400, 'blocked-host', 'redirect → [::1]');
    assert.ok(!seen.some((u) => /internal\.example|127\.0\.0\.1|\[::1\]/.test(u)), `followed: ${seen.join(' ')}`);
    await expectCode(s.fetchVia('https://sheet.example/to-http'), 502, 'upstream', 'redirect → http');
    await expectCode(s.fetchVia('https://sheet.example/loop'), 502, 'upstream', 'redirect loop');
    assert.equal(seen.filter((u) => u.endsWith('/loop')).length, 6, 'the first request + 5 redirects');
    await expectCode(s.fetchVia('https://sheet.example/no-location'), 502, 'upstream', '3xx without Location');
  } finally {
    await s.close();
  }
});

test('roster fetch: Google Sheets edit / share links fetch the CSV export; a private sheet says so', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    const r = await s.fetchVia('https://docs.google.com/spreadsheets/d/PUBLIC_ID/edit?usp=sharing#gid=123');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, 'https://docs.google.com/spreadsheets/d/PUBLIC_ID/export?format=csv&gid=123');
    assert.equal(r.body.text, CSV, 'BOM stripped');
    assert.deepEqual(seen, ['https://docs.google.com/spreadsheets/d/PUBLIC_ID/export?format=csv&gid=123']);
    const p = await expectCode(s.fetchVia('https://docs.google.com/spreadsheets/d/PRIVATE_ID/edit'), 502, 'upstream', 'private sheet');
    assert.equal(p.body.reason, 'not-shared');
    assert.match(p.body.error, /Anyone with the link/);
  } finally {
    await s.close();
  }
});

test('sheetsCsvUrl: edit / view / ?gid / #gid / multi-account / published links; others untouched', () => {
  const conv = (s: string) => sheetsCsvUrl(new URL(s)).href;
  assert.equal(conv('https://docs.google.com/spreadsheets/d/AbC-12_x/edit#gid=0'), 'https://docs.google.com/spreadsheets/d/AbC-12_x/export?format=csv&gid=0');
  assert.equal(conv('https://docs.google.com/spreadsheets/d/AbC/edit?gid=77#gid=77'), 'https://docs.google.com/spreadsheets/d/AbC/export?format=csv&gid=77');
  assert.equal(conv('https://docs.google.com/spreadsheets/d/AbC/view?usp=drive_link'), 'https://docs.google.com/spreadsheets/d/AbC/export?format=csv');
  assert.equal(conv('https://docs.google.com/spreadsheets/d/AbC'), 'https://docs.google.com/spreadsheets/d/AbC/export?format=csv');
  assert.equal(conv('https://docs.google.com/spreadsheets/u/1/d/AbC/edit#gid=5'), 'https://docs.google.com/spreadsheets/d/AbC/export?format=csv&gid=5');
  assert.equal(conv('https://docs.google.com/spreadsheets/d/e/2PACX-1vQ/pubhtml?gid=9&single=true'), 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ/pub?output=csv&gid=9&single=true');
  assert.equal(conv('https://docs.google.com/spreadsheets/d/e/2PACX-1vQ/pub?output=html'), 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ/pub?output=csv');
  for (const same of ['https://docs.google.com/spreadsheets/d/AbC/export?format=csv&gid=3', 'https://docs.google.com/spreadsheets/d/AbC/gviz/tq?tqx=out:csv', 'https://sheet.example/roster.csv', 'https://docs.google.com/document/d/AbC/edit']) {
    assert.equal(conv(same), new URL(same).href, same);
  }
});

test('roster fetch: over 2 MB → 413 too-large (declared or streamed); exactly 2 MB is fine', async () => {
  const s = await setup();
  try {
    await expectCode(s.fetchVia('https://sheet.example/big-declared'), 413, 'too-large', 'Content-Length');
    await expectCode(s.fetchVia('https://sheet.example/big-chunked'), 413, 'too-large', 'chunked');
    const ok = await s.fetchVia('https://sheet.example/exactly-2mb');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.text.length, 2 * 1024 * 1024);
  } finally {
    await s.close();
  }
});

test('roster fetch: non-text types → 415; upstream errors, unknown hosts and timeouts → 502', async () => {
  const s = await setup();
  try {
    await expectCode(s.fetchVia('https://sheet.example/image'), 415, 'unsupported-media', 'png');
    await expectCode(s.fetchVia('https://sheet.example/pdf'), 415, 'unsupported-media', 'pdf');
    await expectCode(s.fetchVia('https://sheet.example/octet-binary'), 415, 'unsupported-media', 'binary .xls');
    const e = await expectCode(s.fetchVia('https://sheet.example/500'), 502, 'upstream', '500');
    assert.equal(e.body.status, 500);
    await expectCode(s.fetchVia('https://sheet.example/403'), 502, 'upstream', '403');
    await expectCode(s.fetchVia('https://nowhere.example/x'), 502, 'upstream', 'DNS failure');
    const slow = await expectCode(s.fetchVia('https://sheet.example/slow'), 502, 'upstream', 'timeout');
    assert.match(slow.body.error, /too long/);
  } finally {
    await s.close();
  }
});

test('roster fetch: the default transport connects only to the address that was checked (no second lookup)', async () => {
  // DNS answers public once, then private (rebinding). The real https transport must never ask DNS again.
  let calls = 0;
  const rebind = async () => (++calls === 1 ? [PUBLIC4] : [{ address: '127.0.0.1', family: 4 }]);
  const pinned: string[] = [];
  const get = async (_u: URL, addr: LookupAddress): Promise<HopResponse> => {
    pinned.push(addr.address);
    return { status: 200, headers: { 'content-type': 'text/csv' }, body: (async function* () { yield new TextEncoder().encode(CSV); })(), close() {} };
  };
  const r = await fetchRoster('https://sheet.example/roster.csv', { lookup: rebind, get });
  assert.equal(r.text, CSV);
  assert.deepEqual(pinned, ['93.184.215.14']);
  assert.equal(calls, 1);
});

test('isBlockedAddress: private, loopback, link-local, CGNAT, multicast, ULA and embedded IPv4 forms', () => {
  for (const ip of [
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '127.255.255.254', '100.64.0.1', '100.127.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '2002:c0a8:101::1', '2001:0:4136:e378::1', '100::1',
    'not-an-ip', '1.2.3', '1.2.3.256', '1::2::3',
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['93.184.215.14', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '2a00:1450:4009::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});
