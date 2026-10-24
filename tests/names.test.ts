/*
 * The short store name the screens lead with: "ASUS ROG Exclusive Store — Incredible Technologies" →
 * "Incredible Technologies", with the dropped part available as a small kicker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignStoreNames, storePrefix, storeShortName } from '../src/lib/names.ts';

const rog = (x: string) => `ASUS ROG Exclusive Store — ${x}`;

test('the known ASUS ROG Exclusive Store prefix goes, whatever the separator', () => {
  assert.equal(storeShortName(rog('Incredible Technologies')), 'Incredible Technologies');
  assert.equal(storePrefix(rog('Incredible Technologies')), 'ASUS ROG Exclusive Store');
  assert.equal(storeShortName('ASUS ROG Exclusive Store - San Infotech'), 'San Infotech');
  assert.equal(storeShortName('ASUS ROG Exclusive Store – San Infotech'), 'San Infotech');
  assert.equal(storeShortName('ASUS ROG Exclusive Store—San Infotech'), 'San Infotech');
  assert.equal(storeShortName('asus rog exclusive store — san infotech'), 'san infotech');
  assert.equal(storeShortName('ASUS ROG Exclusive Store San Infotech'), 'San Infotech');
  assert.equal(storePrefix('ASUS ROG Exclusive Store San Infotech'), 'ASUS ROG Exclusive Store');
});

test('a name that is only the prefix, or has none, stays as it is', () => {
  assert.equal(storeShortName('ASUS ROG Exclusive Store'), 'ASUS ROG Exclusive Store');
  assert.equal(storePrefix('ASUS ROG Exclusive Store'), '');
  assert.equal(storeShortName('ASUS ROG Exclusive Store — '), 'ASUS ROG Exclusive Store —');
  assert.equal(storeShortName('Vijay Sales'), 'Vijay Sales');
  assert.equal(storePrefix('Vijay Sales'), '');
  assert.equal(storeShortName(''), '');
});

test('a dash inside a word is not a separator', () => {
  assert.equal(storeShortName('Reliance Digital Mini-Store', ['Reliance Digital Mini-Store', 'Reliance Digital Mega-Store']), 'Reliance Digital Mini-Store');
  assert.equal(storeShortName(rog('E-Zone Plaza')), 'E-Zone Plaza');
});

test('a prefix every store of the campaign shares goes too', () => {
  const sibs = ['Croma — Andheri', 'Croma — Bandra', 'Croma — Thane'];
  assert.equal(storeShortName('Croma — Bandra', sibs), 'Bandra');
  assert.equal(storePrefix('Croma — Bandra', sibs), 'Croma');
  assert.equal(storeShortName('Croma - Bandra', ['Croma - Andheri', 'Croma - Bandra']), 'Bandra');
  assert.equal(storeShortName('Croma – Bandra', ['Croma – Andheri', 'Croma – Bandra']), 'Bandra');
});

test('the known prefix plus a shared chain name both go, and the kicker names them', () => {
  const sibs = [rog('Croma — Andheri'), rog('Croma — Bandra')];
  assert.equal(storeShortName(rog('Croma — Bandra'), sibs), 'Bandra');
  assert.equal(storePrefix(rog('Croma — Bandra'), sibs), 'ASUS ROG Exclusive Store — Croma');
});

test('a prefix only some stores have is kept', () => {
  const sibs = ['Croma — Andheri', 'Croma — Bandra', 'Reliance Digital — Thane'];
  assert.equal(storeShortName('Croma — Bandra', sibs), 'Croma — Bandra');
  assert.equal(storePrefix('Croma — Bandra', sibs), '');
  // one store alone has nothing to share with
  assert.equal(storeShortName('Croma — Bandra', ['Croma — Bandra']), 'Croma — Bandra');
  assert.equal(storeShortName('Croma — Bandra'), 'Croma — Bandra');
  // a store with a plain name among them
  assert.equal(storeShortName('Croma — Bandra', ['Croma — Bandra', 'Vijay Sales']), 'Croma — Bandra');
});

test('the last part of every name always stays', () => {
  // two branches with the same full name (told apart by city)
  const twins = [rog('Croma'), rog('Croma')];
  assert.equal(storeShortName(rog('Croma'), twins), 'Croma');
  const same = ['A — B', 'A — B'];
  assert.equal(storeShortName('A — B', same), 'B');
  assert.equal(storePrefix('A — B', same), 'A');
});

test('only whole parts are shared, compared ignoring case', () => {
  assert.equal(storeShortName('Croma Mall — X', ['Croma Mall — X', 'Croma — Y']), 'Croma Mall — X');
  assert.equal(storeShortName('CROMA — X', ['croma — x', 'Croma — Y']), 'X');
});

test('campaignStoreNames lists one campaign’s store names', () => {
  const stores = [
    { name: rog('A'), eventId: 'e1' },
    { name: rog('B'), eventId: 'e2' },
    { name: rog('C'), eventId: 'e1' },
  ];
  assert.deepEqual(campaignStoreNames(stores, 'e1'), [rog('A'), rog('C')]);
  assert.deepEqual(campaignStoreNames(Object.values(stores), 'none'), []);
});
