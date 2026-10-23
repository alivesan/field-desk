import { test } from 'node:test';
import assert from 'node:assert/strict';
import type os from 'node:os';
import { lanOrigins } from '../server/lan.ts';
import { startTestServer, seedBasic } from './helpers/server.ts';

/* GET /api/lan — the PC's Wi-Fi addresses, so links HQ makes on localhost work on a phone. */

const nic = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as unknown as os.NetworkInterfaceInfo;

test('lanOrigins: private addresses only, home Wi-Fi first, no loopback / link-local / public', () => {
  const nics = {
    lo: [nic('127.0.0.1', true)],
    vpn: [nic('10.8.0.2')],
    wifi: [nic('192.168.1.35'), { ...nic('fe80::1'), family: 'IPv6' } as unknown as os.NetworkInterfaceInfo],
    apipa: [nic('169.254.10.2')],
    docker: [nic('172.17.0.1')],
    pub: [nic('203.0.113.9')],
  };
  assert.deepEqual(lanOrigins('https', 5173, nics), ['https://192.168.1.35:5173', 'https://10.8.0.2:5173', 'https://172.17.0.1:5173']);
  assert.deepEqual(lanOrigins('http', 80, { wifi: [nic('192.168.0.4')] }), ['http://192.168.0.4']);
  assert.deepEqual(lanOrigins('http', 8080, { lo: [nic('127.0.0.1', true)] }), []);
});

test('GET /api/lan: signed-in only; a localhost-only server says phones can’t reach it', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    assert.equal((await t.json('/api/lan')).status, 401);
    const r = await t.json('/api/lan', { cookie: hq });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.origins));
    for (const o of r.body.origins) assert.match(o, /^http:\/\/(192\.168|10|172)\.[\d.]+:\d+$/);
    assert.equal(r.body.https, false);
    assert.equal(r.body.reachable, false, 'the test server listens on 127.0.0.1 only');
    const admin = await t.login('AAA2');
    assert.equal((await t.json('/api/lan', { cookie: admin })).status, 200);
  } finally {
    await t.close();
  }
});
