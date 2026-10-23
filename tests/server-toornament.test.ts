import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { startTestServer, seedBasic } from './helpers/server.ts';
import type { HopResponse, LookupAddress, RosterFetchOptions } from '../server/roster-fetch.ts';

/*
 * GET /api/toornament/fetch — HQ's Toornament link. Like the roster-fetch tests: a fake DNS and a
 * transport that sends every hop to a local http server (hostname in a header), which answers
 * play.toornament.com's JSON from the trimmed fixtures in tests/fixtures/toornament/. No network.
 */

const DNS: Record<string, LookupAddress[]> = {
  'play.toornament.com': [{ address: '104.18.20.1', family: 4 }],
  'evil.example': [{ address: '93.184.215.14', family: 4 }],
  'intranet.toornament.com': [{ address: '10.0.0.7', family: 4 }],
};
const lookup = async (host: string) => {
  const a = DNS[host];
  if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return a;
};

const fixtures = ['se8', 'se7', 'se12', 'multi', 'de'].map((n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/toornament/${n}.json`, import.meta.url), 'utf8')));
const byTournament = new Map<string, any>(fixtures.map((f) => [f.tournament.id, f]));
// A synthetic tournament with 60 registered (two pages) and a Swiss stage (no bracket fetched).
const many = Array.from({ length: 60 }, (_, i) => ({ id: String(5000 + i), type: 'player', name: `Player ${i + 1}` }));
byTournament.set('999', {
  tournament: { id: '999', name: 'Big Swiss', status: 'pending', participantType: 'single' },
  stages: { items: [{ id: '9991', number: 1, name: 'Swiss', type: 'swiss', status: 'pending', settings: { size: 64 } }], range: { offset: 0, length: 1, total: 1 } },
  participants: { items: many, range: { offset: 0, length: 60, total: 60 } },
});

const seen: string[] = [];

function upstream() {
  return http.createServer((req, res) => {
    const host = String(req.headers['x-host']);
    const u = new URL(req.url!, `https://${host}`);
    seen.push(u.href);
    const json = (status: number, body: unknown) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(body)));
    const go = (loc: string) => (res.writeHead(302, { Location: loc }), res.end());
    if (host !== 'play.toornament.com') return json(404, {});
    const tid = u.searchParams.get('tournament_ids') ?? u.pathname.match(/^\/api\/tournaments\/(\d+)$/)?.[1] ?? '';
    if (tid === '777') return go('https://evil.example/api/tournaments/777');
    if (tid === '778') return go('https://intranet.toornament.com/api/tournaments/778');
    if (tid === '779') return (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end('<html>maintenance</html>'));
    const f = byTournament.get(tid);
    if (u.pathname.startsWith('/api/tournaments/')) return f ? json(200, f.tournament) : json(404, {});
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const page = (list: { items: unknown[] } | undefined, max: number) => {
      if (limit > max) return json(400, { errors: [{ message: 'The specified limit is outside the permitted range.' }] });
      const items = (list?.items ?? []).slice(offset, offset + limit);
      return json(200, { items, range: { offset, length: items.length, total: list?.items.length ?? 0 } });
    };
    if (u.pathname === '/api/stages') return page(f?.stages, 50);
    if (u.pathname === '/api/participants') return page(f?.participants, 50);
    if (u.pathname === '/api/bracket-nodes') {
      const stage = u.searchParams.get('stage_ids');
      return page(f?.nodes && f.nodes.items.every((n: any) => n.stage.id === stage) ? f.nodes : undefined, 128);
    }
    return json(404, {});
  });
}

async function setup() {
  const up = upstream();
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  const port = (up.address() as { port: number }).port;
  const get = async (url: URL, _addr: LookupAddress, signal: AbortSignal): Promise<HopResponse> => {
    const r = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { redirect: 'manual', signal, headers: { 'x-host': url.hostname } });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: (r.body ?? (async function* () {})()) as AsyncIterable<Uint8Array>, close: () => void r.body?.cancel().catch(() => {}) };
  };
  const rosterFetch: RosterFetchOptions = { lookup, get, timeoutMs: 1500 };
  const t = await startTestServer({ rosterFetch });
  const hq = await seedBasic(t);
  const a1 = await t.login('AAA2');
  const fetchVia = (link: string, stage?: string, cookie = hq) =>
    t.json(`/api/toornament/fetch?url=${encodeURIComponent(link)}${stage ? `&stage=${stage}` : ''}`, { cookie });
  return {
    t,
    hq,
    a1,
    fetchVia,
    close: async () => {
      up.closeAllConnections();
      up.close();
      await t.close();
    },
  };
}

const link = (tid: string, sid?: string) => `https://play.toornament.com/en_US/tournaments/${tid}/${sid ? `stages/${sid}/` : ''}`;

test('toornament fetch: HQ only — field admins 403, no session 401', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    const r = await s.fetchVia(link('2606138892358238208'), undefined, s.a1);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
    assert.equal((await s.t.json(`/api/toornament/fetch?url=${encodeURIComponent(link('2606138892358238208'))}`)).status, 401);
    assert.deepEqual(seen, [], 'nothing fetched for them');
  } finally {
    await s.close();
  }
});

test('toornament fetch: a tournament link → stages, registered names and the first round, from the public JSON only', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    const r = await s.fetchVia(link('2606138892358238208'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.tournament.name, 'Synthetic Cup — 8 slots');
    assert.equal(r.body.stage.type, 'single_elimination');
    assert.equal(r.body.participants.length, 8);
    assert.equal(r.body.bracket.mode, 'pairs');
    assert.deepEqual(r.body.bracket.pairs[2], ['Diya Patel', null]);
    assert.ok(Date.parse(r.body.fetchedAt) > 0);
    assert.ok(seen.every((u) => u.startsWith('https://play.toornament.com/api/')), seen.join('\n'));
    assert.deepEqual(
      seen.map((u) => new URL(u).pathname),
      ['/api/tournaments/2606138892358238208', '/api/stages', '/api/participants', '/api/bracket-nodes'],
    );
  } finally {
    await s.close();
  }
});

test('toornament fetch: the stage in the link, or ?stage=, picks the stage; unsupported stages are explained, no bracket fetched', async () => {
  const s = await setup();
  try {
    const multi = await s.fetchVia(link('1341889430865920000'));
    assert.equal(multi.status, 200);
    assert.equal(multi.body.stages.length, 2);
    assert.equal(multi.body.stage.name, 'Playoffs', 'the usable stage first');
    assert.equal(multi.body.bracket.mode, 'seeded');
    seen.length = 0;
    const league = await s.fetchVia(link('1341889430865920000'), '1341891244374917120');
    assert.equal(league.body.stage.type, 'league');
    assert.equal(league.body.stage.supported, false);
    assert.match(league.body.stage.reason, /League can’t be run here/);
    assert.equal(league.body.bracket, null);
    assert.ok(!seen.some((u) => u.includes('bracket-nodes')), 'no bracket for an unsupported stage');
    const viaLink = await s.fetchVia(link('1341889430865920000', '1341891244374917120'));
    assert.equal(viaLink.body.stage.type, 'league');
    const de = await s.fetchVia(link('2001331429601337344'));
    assert.match(de.body.stage.reason, /Double elimination/);
    const gone = await s.fetchVia(link('1341889430865920000'), '123');
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /stage isn’t in this tournament/);
  } finally {
    await s.close();
  }
});

test('toornament fetch: participants are paged (50 at a time)', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    const r = await s.fetchVia(link('999'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.participants.length, 60);
    assert.equal(r.body.participantsTotal, 60);
    assert.deepEqual(seen.filter((u) => u.includes('/participants')).map((u) => new URL(u).searchParams.get('offset')), ['0', '50']);
  } finally {
    await s.close();
  }
});

test('toornament fetch: not a toornament link → 400 before any request; unknown tournament → 404; odd answers → 502', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    for (const bad of ['https://evil.example/tournaments/1/', 'not a link', '', 'https://play.toornament.com/en_US/games/']) {
      const r = await s.fetchVia(bad);
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.code, 'bad-url', bad);
    }
    assert.equal((await s.fetchVia(link('1'), 'x/../y')).status, 400, 'stage must be digits');
    assert.deepEqual(seen, []);
    const missing = await s.fetchVia(link('424242'));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not-found');
    assert.match(missing.body.error, /no public tournament/);
    const html = await s.fetchVia(link('779'));
    assert.equal(html.status, 502);
    assert.match(html.body.error, /Toornament/);
  } finally {
    await s.close();
  }
});

test('toornament fetch: redirects may not leave toornament.com, nor reach a private address', async () => {
  const s = await setup();
  try {
    seen.length = 0;
    const off = await s.fetchVia(link('777'));
    assert.equal(off.status, 502);
    assert.equal(off.body.code, 'upstream');
    const priv = await s.fetchVia(link('778'));
    assert.equal(priv.status, 400);
    assert.equal(priv.body.code, 'blocked-host');
    assert.ok(!seen.some((u) => /evil\.example|intranet/.test(u)), seen.join('\n'));
  } finally {
    await s.close();
  }
});

test('store.toornament: HQ sets it with a normal edit; a field admin can’t; a non-toornament link is invalid', async () => {
  const s = await setup();
  try {
    const batch = (cookie: string, id: string, v: unknown) => s.t.json('/api/batch', { method: 'POST', cookie, body: { id, ops: [{ k: 'stores', id: 's1', p: ['toornament'], v }] } });
    const byAdmin = await batch(s.a1, 'tn-admin-0001', { url: link('1') });
    assert.equal(byAdmin.status, 403);
    assert.equal(byAdmin.body.code, 'forbidden');
    assert.equal((await batch(s.hq, 'tn-hq-000001', { url: link('2606138892358238208') })).status, 200);
    const bad = await batch(s.hq, 'tn-hq-000002', { url: 'https://evil.example/x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid');
  } finally {
    await s.close();
  }
});
