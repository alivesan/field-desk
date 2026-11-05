import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../mock/server.mjs';
import { createService } from '../worker/service.mjs';

test('lost delivery response survives worker restart and replays the same idempotency key', async t => {
  const start = Date.parse('2026-10-30T06:00:00.000Z');
  let clock = start;
  const parent = new URL('../test-output/', import.meta.url);
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(new URL('fd-recovery-', parent));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mock = createServer({ apiKey: 'synthetic-recovery-key', now: () => clock });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => mock.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${mock.address().port}`;
  const attemptedKeys = [];
  let loseReply = true;
  const options = {
    statePath: join(directory, 'state.json'),
    mailboxes: [{ id: 'central-gmail', provider: 'gmail' }],
    baseUrl: `${origin}/api/v1`, apiKey: 'synthetic-recovery-key',
    webhookSecret: 'synthetic-recovery-signature', now: () => clock,
    fetchImpl: async (url, init) => {
      if (!url.endsWith('/steam/otp')) return fetch(url, init);
      attemptedKeys.push(init.headers['Idempotency-Key']);
      const reply = await fetch(url, init);
      if (loseReply) {
        assert.equal(reply.status, 200);
        await reply.arrayBuffer(); // The mock committed; only the acknowledgement is lost.
        loseReply = false;
        throw new Error('synthetic connection reset after commit');
      }
      return reply;
    },
  };
  const input = {
    mailbox: 'central-gmail', provider: 'gmail', message: {
      id: 'recovery-message', internalDate: String(start), payload: {
        mimeType: 'text/plain', headers: [
          { name: 'From', value: 'Steam <noreply@steampowered.com>' },
          { name: 'Date', value: new Date(start).toUTCString() },
          { name: 'Subject', value: 'Steam Guard code' },
          { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' },
        ], body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') },
      },
    },
  };
  let service = await createService(options);
  const lost = await service.process(input);
  assert.equal(lost.body.status, 'fielddesk_unavailable');
  assert.equal(lost.body.markProcessed, false);
  const storedBeforeRetry = (await (await fetch(`${origin}/mock/cards`)).json()).cards[0];
  assert.equal(storedBeforeRetry.active, true);

  clock += 60_000;
  service = await createService(options);
  assert.equal((await service.process(input)).body.status, 'delivered');
  assert.equal((await service.process(input)).body.status, 'already_delivered');
  assert.equal(attemptedKeys.length, 2);
  assert.equal(attemptedKeys[0], attemptedKeys[1]);
  const storedAfterRetry = (await (await fetch(`${origin}/mock/cards`)).json()).cards[0];
  assert.equal(storedAfterRetry.receivedAt, storedBeforeRetry.receivedAt);
  assert.equal(storedAfterRetry.expiresAt, storedBeforeRetry.expiresAt);
  const ledger = await readFile(options.statePath, 'utf8');
  assert.equal(Object.keys(JSON.parse(ledger).delivered).length, 1);
  for (const forbidden of ['A1B2C', 'Steam Guard code', 'synthetic-recovery-key', 'synthetic connection reset']) {
    assert.equal(ledger.includes(forbidden), false);
  }
});
