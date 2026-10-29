import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../mock/server.mjs';
import { createService } from '../worker/service.mjs';

test('synthetic Gmail message reaches the mock store, deduplicates, then expires', async () => {
  const start = Date.parse('2026-10-25T12:00:00.000Z');
  let currentTime = start;
  const testDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-output');
  await mkdir(testDirectory, { recursive: true });
  const temp = await mkdtemp(join(testDirectory, '.integration-'));
  const server = createServer({ apiKey: 'integration-secret', now: () => currentTime });
  try {
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const service = await createService({
      statePath: join(temp, 'state.json'),
      mailboxes: [{ id: 'central-gmail', provider: 'gmail', trustedForwarders: [] }],
      baseUrl: `${origin}/api/v1`,
      apiKey: 'integration-secret',
      webhookSecret: 'integration-webhook-secret',
      now: () => currentTime,
    });
    const message = {
      id: 'synthetic-message-1',
      internalDate: String(start),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Steam <noreply@steampowered.com>' },
          { name: 'To', value: 'login-alpha@example.invalid' },
          { name: 'Date', value: new Date(start).toUTCString() },
          { name: 'Subject', value: 'Steam Guard login code' },
          { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' },
        ],
        body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') },
      },
    };
    const input = { mailbox: 'central-gmail', provider: 'gmail', message };
    const first = await service.process(input);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'delivered');
    assert.equal(first.body.markProcessed, true);

    const cardsResponse = await fetch(`${origin}/mock/cards`);
    assert.equal(cardsResponse.status, 200);
    const cards = await cardsResponse.json();
    assert.equal(cards.cards[0].accountUsername, 'store_alpha');
    assert.equal(cards.cards[0].active, true);
    assert.equal(JSON.stringify(cards).includes('A1B2C'), false);
    const storeResponse = await fetch(`${origin}/mock/store`);
    assert.match(storeResponse.headers.get('content-type'), /text\/html/);
    const html = await storeResponse.text();
    assert.match(html, /A1B2C/);
    assert.match(html, /store_alpha/);

    const duplicate = await service.process(input);
    assert.equal(duplicate.body.status, 'already_delivered');
    assert.equal(duplicate.body.markProcessed, true);
    const state = await readFile(join(temp, 'state.json'), 'utf8');
    assert.equal(state.includes('A1B2C'), false);

    currentTime = start + 600_000;
    const expiredCards = await (await fetch(`${origin}/mock/cards`)).json();
    assert.equal(expiredCards.cards[0].active, false);
    assert.doesNotMatch(await (await fetch(`${origin}/mock/store`)).text(), /A1B2C/);
    const stale = await service.process({ ...input, message: { ...message, id: 'synthetic-message-2' } });
    assert.equal(stale.body.status, 'expired_or_invalid_time');
    assert.equal(stale.body.markProcessed, false);
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    const tempRoot = resolve(testDirectory);
    if (resolve(temp).startsWith(`${tempRoot}${sep}`)) await rm(temp, { recursive: true, force: true });
  }
});
