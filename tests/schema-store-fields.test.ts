/* Store.state / Store.exclusive and TournamentEvent.storeSheet in the document schema. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '../src/lib/schema.ts';
import { fixtureEvent, fixtureStore } from './helpers/server.ts';

const ctx = () => ({ events: { e1: fixtureEvent('e1') as any } });
const store = (over: Record<string, unknown> = {}) => fixtureStore('s1', 'e1', null, over) as any;
const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}, got ${JSON.stringify(problems)}`);

test('schema: store state and exclusive are optional', () => {
  assert.deepEqual(validateDocument('stores', store(), ctx()), []);
  assert.deepEqual(validateDocument('stores', store({ state: 'Maharashtra', exclusive: true }), ctx()), []);
  assert.deepEqual(validateDocument('stores', store({ state: '', exclusive: false }), ctx()), []);
});

test('schema: state must be text of at most 200, exclusive a boolean', () => {
  has(validateDocument('stores', store({ state: 5 }), ctx()), /^state: must be text/);
  has(validateDocument('stores', store({ state: 'x'.repeat(201) }), ctx()), /^state: must be text of at most 200/);
  has(validateDocument('stores', store({ exclusive: 'yes' }), ctx()), /^exclusive: must be true or false/);
  has(validateDocument('stores', store({ exclusive: 1 }), ctx()), /^exclusive: must be true or false/);
});

test('schema: the campaign’s store sheet is a link and a time', () => {
  const e = (storeSheet: unknown) => fixtureEvent('e1', { storeSheet });
  assert.deepEqual(validateDocument('events', e({ url: 'https://docs.google.com/spreadsheets/d/x/edit', fetchedAt: '2026-10-20T10:00:00.000Z' }), ctx()), []);
  assert.deepEqual(validateDocument('events', fixtureEvent('e1'), ctx()), []);
  has(validateDocument('events', e('nope'), ctx()), /^storeSheet: must be an object/);
  has(validateDocument('events', e({ url: 5, fetchedAt: '2026-10-20T10:00:00.000Z' }), ctx()), /^storeSheet\.url: must be text/);
  has(validateDocument('events', e({ url: 'https://x.y/z', fetchedAt: 'yesterday' }), ctx()), /^storeSheet\.fetchedAt: must be a date-time/);
});
