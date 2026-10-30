/*
 * Marketing (src/lib/marketing.ts): the Discord post and the WhatsApp promo built from the owner's templates, character for
 * character; what stays visible when something is missing; the weekends the page lists; and that event.marketing is HQ's alone.
 * Synthetic data only. Today is Thu 29 Oct 2026, so this weekend is Sat 31 Oct / Sun 1 Nov and the next is Sat 7 / Sun 8 Nov.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignIssues,
  defaultDiscordClosing,
  defaultDiscordIntro,
  defaultPlayerIntro,
  defaultWhatsappIntro,
  discordPost,
  DISCORD_INVITE,
  gameName,
  longDate,
  longDay,
  marketingText,
  marketingWeekends,
  playerIssues,
  playerMessage,
  posterOf,
  storeIssues,
  TEKKEN_RULES,
  whatsappPromo,
} from '../src/lib/marketing.ts';
import { validateDocument } from '../src/lib/schema.ts';
import type { Admin, EventMarketing, Store, TournamentEvent } from '../src/lib/types.ts';
import { fixtureEvent, fixtureStore, seedBasic, startTestServer } from './helpers/server.ts';

const TODAY = '2026-10-29';
const SET: EventMarketing = { prizePool: '10,000', reportingTime: '11:00 AM', firstMatch: '12:00 PM', discordIntro: 'The Valorant stage is set.', discordClosing: 'Lock in and queue up.', whatsappIntro: 'Squad up for Valorant!' };

const ev = (over: Record<string, unknown> = {}) => fixtureEvent('e1', { name: 'ROG Showdown Valorant', date: '2026-10-31', games: ['Valorant'], marketing: SET, ...over }) as unknown as TournamentEvent;
const st = (id: string, over: Record<string, unknown> = {}) =>
  fixtureStore(id, 'e1', null, { name: `ASUS ROG Exclusive Store — ${id}`, city: 'Mumbai', mapsUrl: `https://maps.app.goo.gl/${id}`, toornament: { url: `https://play.toornament.com/en_GB/tournaments/${id}/` }, ...over }) as unknown as Store;

// Two days × three stores, handed over in a jumbled order; one has no date of its own (the campaign's, Saturday).
const jumbled = () => [
  st('Pune Beta', { city: 'Pune', date: '2026-11-01' }),
  st('Mumbai Zeta'),
  st('Delhi Delta', { city: 'Delhi', date: '2026-11-01' }),
  st('Omega', { city: 'Bengaluru', date: '2026-10-31' }),
  st('Pune Gamma', { city: 'Pune', date: '2026-11-01' }),
  st('Mumbai Alpha', { date: '2026-10-31' }),
];
const block = (city: string, name: string, id: string) =>
  `**${city} — ASUS ROG Exclusive Store — ${name}**\nRegister: <https://play.toornament.com/en_GB/tournaments/${id}/>\nGmap: <https://maps.app.goo.gl/${id}>`;

test('the Discord post: the owner\'s template, a heading per day, stores by city then name', () => {
  const expected = [
    '@everyone',
    '# ROG SHOWDOWN | Valorant',
    'The Valorant stage is set.',
    '**Valorant | ₹10,000 Prize Pool | FREE ENTRY**',
    'Reporting: **11:00 AM**\nFirst Match: **12:00 PM**',
    '## Saturday, 31 October',
    block('Bengaluru', 'Omega', 'Omega'),
    block('Mumbai', 'Mumbai Alpha', 'Mumbai Alpha'),
    block('Mumbai', 'Mumbai Zeta', 'Mumbai Zeta'),
    '## Sunday, 1 November',
    block('Delhi', 'Delhi Delta', 'Delhi Delta'),
    block('Pune', 'Pune Beta', 'Pune Beta'),
    block('Pune', 'Pune Gamma', 'Pune Gamma'),
    'Lock in and queue up.',
    'Questions? Drop them in the thread.',
  ].join('\n\n');
  assert.equal(discordPost(ev(), jumbled()), expected);
  assert.equal(discordPost(ev({ marketing: undefined }), jumbled(), SET), expected, 'settings can be passed in (HQ\'s unsaved draft)');
  // the template's skeleton, spelled out once
  assert.ok(expected.startsWith('@everyone\n\n# ROG SHOWDOWN | Valorant\n\nThe Valorant stage is set.\n\n**Valorant | ₹10,000 Prize Pool | FREE ENTRY**\n\nReporting: **11:00 AM**\nFirst Match: **12:00 PM**\n\n## Saturday, 31 October\n\n**Bengaluru — ASUS'));
  assert.ok(expected.endsWith('Gmap: <https://maps.app.goo.gl/Pune Gamma>\n\nLock in and queue up.\n\nQuestions? Drop them in the thread.'));
});

test('the WhatsApp promo: the owner\'s template, filled', () => {
  const store = st('Mumbai Alpha', { date: '2026-11-01' });
  assert.equal(
    whatsappPromo(ev(), store),
    [
      '*ROG SHOWDOWN - Mumbai*',
      '*Valorant | ₹10,000 Prize Pool | Free Entry*',
      '*Date:* Sunday, 1 November 2026',
      '',
      'Squad up for Valorant!',
      '',
      '*Venue:* ASUS ROG Exclusive Store — Mumbai Alpha, Mumbai',
      '*Game:* Valorant',
      '*Prize Pool:* ₹10,000',
      '*Reporting Time:* 11:00 AM',
      '*First Match:* 12:00 PM',
      '',
      '*Register Now:* https://play.toornament.com/en_GB/tournaments/Mumbai Alpha/',
      '*Location:* https://maps.app.goo.gl/Mumbai Alpha',
      '*Discord:* https://discord.gg/AeqmQyy3TB',
    ].join('\n'),
  );
  assert.ok(whatsappPromo(ev(), store, { ...SET, discordInvite: ' https://discord.gg/other ' }).endsWith('*Discord:* https://discord.gg/other'));
});

test('missing links and facts stay in the text as [… missing] and are listed in words', () => {
  const bare = st('Bare', { toornament: undefined, mapsUrl: '', city: '' });
  assert.deepEqual(storeIssues(bare), ['No city', 'No Toornament link', 'No Maps link']);
  assert.deepEqual(storeIssues(st('Fine')), []);
  const post = discordPost(ev(), [bare]);
  assert.ok(post.includes('**[City missing] — ASUS ROG Exclusive Store — Bare**\nRegister: <[Toornament link missing]>\nGmap: <[Maps link missing]>'));
  const promo = whatsappPromo(ev(), bare);
  assert.ok(promo.includes('*Register Now:* [Toornament link missing]\n*Location:* [Maps link missing]'));
  assert.ok(promo.startsWith('*ROG SHOWDOWN - [City missing]*'));

  // the prize pool and times are fixed for the ROG Showdown: nothing typed means ₹30,000, 11:00 AM, 12:30 PM
  const empty = whatsappPromo(ev({ marketing: undefined }), st('x'));
  assert.ok(empty.includes('*Valorant | ₹30,000 Prize Pool | Free Entry*'));
  assert.ok(empty.includes('*Reporting Time:* 11:00 AM\n*First Match:* 12:30 PM'));
  // only the rules can be missing: a game without stock rules, until HQ types them
  assert.deepEqual(campaignIssues(ev(), {}), ['No rules']);
  assert.deepEqual(campaignIssues(ev(), { rules: '– Bo3' }), []);
  assert.deepEqual(campaignIssues({ name: 'x', games: ['Tekken 8'] }, {}), []);
});

test('empty promo texts fall back to defaults with the game name in them', () => {
  const m = marketingText(ev(), {});
  assert.equal(m.discordIntro, defaultDiscordIntro('Valorant'));
  assert.equal(m.discordClosing, defaultDiscordClosing('Valorant'));
  assert.equal(m.whatsappIntro, defaultWhatsappIntro('Valorant'));
  assert.equal(m.discordInvite, DISCORD_INVITE);
  assert.ok([m.discordIntro, m.discordClosing, m.whatsappIntro].every((t) => t.includes('Valorant')));
  // blank (spaces only) counts as empty; the ₹ is not doubled
  assert.equal(marketingText(ev(), { discordIntro: '   ', prizePool: ' ₹ 5,000 ' }).discordIntro, defaultDiscordIntro('Valorant'));
  assert.equal(marketingText(ev(), { prizePool: ' ₹ 5,000 ' }).prizePool, '5,000');
  const post = discordPost(ev({ marketing: undefined }), jumbled());
  assert.ok(post.includes(defaultDiscordIntro('Valorant')) && post.includes(defaultDiscordClosing('Valorant')));
});

test('the game name: the first game, several joined, else the campaign name', () => {
  assert.equal(gameName({ name: 'Camp', games: ['Valorant'] }), 'Valorant');
  assert.equal(gameName({ name: 'Camp', games: ['Valorant', ' Tekken 8 ', ''] }), 'Valorant / Tekken 8');
  assert.equal(gameName({ name: ' Camp ', games: [] }), 'Camp');
  assert.ok(discordPost(ev({ games: ['A', 'B'] }), [st('x')]).includes('# ROG SHOWDOWN | A / B'));
});

test('dates are read as written: the day never shifts', () => {
  assert.equal(longDay('2026-10-31'), 'Saturday, 31 October');
  assert.equal(longDay('2026-01-01'), 'Thursday, 1 January');
  assert.equal(longDay('2026-03-01'), 'Sunday, 1 March');
  assert.equal(longDate('2026-12-31'), 'Thursday, 31 December 2026');
  const was = process.env.TZ;
  try {
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      assert.equal(longDate('2026-10-31'), 'Saturday, 31 October 2026', tz);
    }
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
  // a store's own date wins over the campaign's
  assert.ok(whatsappPromo(ev(), st('x', { date: '2026-11-01' })).includes('*Date:* Sunday, 1 November 2026'));
  assert.ok(whatsappPromo(ev(), st('x')).includes('*Date:* Saturday, 31 October 2026'));
});

test('the poster is the print kit\'s poster file', () => {
  assert.equal(posterOf(st('x')), undefined);
  const kit = { files: [{ kind: 'standee', driveId: 'a'.repeat(28), url: 'u' }, { kind: 'poster', driveId: 'b'.repeat(28), url: 'u' }], importedAt: '2026-10-28T10:00:00.000Z' };
  assert.equal(posterOf(st('x', { print: kit }))?.driveId, 'b'.repeat(28));
  assert.equal(posterOf(st('x', { print: { ...kit, files: [kit.files[0]] } })), undefined);
});

test('the page lists this weekend only, by campaign; next weekend (it joins on Monday), later and past stores are left out', () => {
  const e1 = ev({ name: 'Zulu Cup' });
  const e2 = fixtureEvent('e2', { name: 'Alpha Cup', date: '2026-10-31', games: ['Tekken 8'] }) as unknown as TournamentEvent;
  const e3 = fixtureEvent('e3', { name: 'Later Cup', date: '2026-11-14' }) as unknown as TournamentEvent;
  const stores = [
    st('a', { date: '2026-10-31' }),
    st('b', { date: '2026-11-07' }),
    st('past', { date: '2026-10-24' }),
    fixtureStore('c', 'e2', null, { name: 'C', city: 'Delhi' }) as unknown as Store, // the campaign's date
    fixtureStore('d', 'e2', null, { name: 'D', city: 'Agra', date: '2026-11-08' }) as unknown as Store,
    fixtureStore('e', 'e3', null, { name: 'E' }) as unknown as Store,
  ];
  const w = marketingWeekends({ events: { e1, e2, e3 }, stores: Object.fromEntries(stores.map((s) => [s.id, s])) }, TODAY);
  assert.deepEqual(w.map((x) => [x.when, x.title, x.label]), [['this', 'This weekend', 'Sat 31 Oct – Sun 1 Nov']]);
  assert.deepEqual(w[0].campaigns.map((c) => [c.event.name, c.stores.map((s) => s.id)]), [['Alpha Cup', ['c']], ['Zulu Cup', ['a']]]);
  // on the Monday, next weekend's stores are this weekend's
  const monday = marketingWeekends({ events: { e1, e2, e3 }, stores: Object.fromEntries(stores.map((s) => [s.id, s])) }, '2026-11-02');
  assert.deepEqual(monday.map((x) => x.label), ['Sat 7 – Sun 8 Nov']);
  assert.deepEqual(monday[0].campaigns.map((c) => [c.event.name, c.stores.map((s) => s.id)]), [['Alpha Cup', ['d']], ['Zulu Cup', ['b']]]);
  assert.deepEqual(marketingWeekends({ events: { e3 }, stores: { e: stores[5] } }, TODAY), []);
});

test('the players\' message the night before: the owner\'s template, with the bracket page, the rules and the admin to call', () => {
  const tekken = ev({ games: ['Tekken 8'], marketing: undefined });
  const admins: Record<string, Admin> = { ad1: { id: 'ad1', name: 'Rhea', phone: '+91 98765 43210', code: 'K7Q2', createdAt: '2026-10-01T00:00:00.000Z' } };
  const store = st('Mumbai Alpha', { adminId: 'ad1', admin: 'Rhea', toornament: { url: 'https://play.toornament.com/en_GB/tournaments/123456/', stageId: '789' } });
  assert.equal(
    playerMessage(tekken, store, admins),
    [
      'ROG SHOWDOWN - Mumbai',
      'Saturday, 31 October 2026',
      defaultPlayerIntro('Tekken 8'),
      'Venue: ASUS ROG Exclusive Store — Mumbai Alpha, Mumbai',
      'Reporting time: 11:00 AM',
      'First match: 12:30 PM',
      '',
      'Location: https://maps.app.goo.gl/Mumbai Alpha',
      'Bracket: https://play.toornament.com/en_US/tournaments/123456/stages/789/',
      '',
      '',
      'TOURNAMENT RULES',
      'Game: Tekken 8',
      TEKKEN_RULES,
      '',
      "Admin's decision is final.",
      '',
      'Admin contact: Rhea - +91 98765 43210',
      '',
      'See you there.',
      '',
      'Team La-eGamers',
    ].join('\n'),
  );
  assert.ok(TEKKEN_RULES.startsWith('– Format: Single Elimination until Semis\n') && TEKKEN_RULES.endsWith('– winners of event from one city cant participate in other cities'));
  assert.deepEqual(playerIssues(store, admins), []);

  // HQ's own line and rules win; another game has no stock rules
  const typed = playerMessage(ev({ marketing: { playerIntro: 'It’s on!', rules: '– Bo3 all rounds' } }), store, admins);
  assert.ok(typed.includes('Saturday, 31 October 2026\nIt’s on!\nVenue:') && typed.includes('Game: Valorant\n– Bo3 all rounds\n\n'));
  assert.ok(playerMessage(ev({ marketing: undefined }), store, admins).includes('Game: Valorant\n[Rules missing]'));

  // nothing to point at: markers in the text, words on the screen
  const bare = st('Bare', { toornament: undefined, mapsUrl: '', adminId: null, admin: '' });
  const msg = playerMessage(tekken, bare, admins);
  assert.ok(msg.includes('Location: [Maps link missing]\nBracket: [Bracket link missing]'));
  assert.ok(msg.includes('Admin contact: [Admin missing] - [Admin phone missing]'));
  assert.deepEqual(playerIssues(bare, admins), ['No bracket link', 'No Maps link', 'No admin']);
  // an admin HQ's list doesn't have: the name copied onto the store, no phone
  assert.deepEqual(playerIssues(st('x', { adminId: 'gone', admin: 'Old Name' }), admins), ['No admin phone']);
  assert.ok(playerMessage(tekken, st('x', { adminId: 'gone', admin: 'Old Name' }), admins).includes('Admin contact: Old Name - [Admin phone missing]'));
});

test('marketing is checked: known text fields only, with sizes and an https invite', () => {
  const doc = (marketing: unknown) => validateDocument('events', { ...(ev() as object), marketing });
  assert.deepEqual(doc(SET), []);
  assert.deepEqual(doc({}), []);
  assert.deepEqual(doc({ discordInvite: 'https://discord.gg/abc' }), []);
  assert.match(doc({ foo: 'x' }).join(), /marketing\.foo/);
  assert.match(doc({ prizePool: 5 }).join(), /marketing\.prizePool/);
  assert.match(doc({ prizePool: 'x'.repeat(41) }).join(), /marketing\.prizePool/);
  assert.match(doc({ discordIntro: 'x'.repeat(1001) }).join(), /marketing\.discordIntro/);
  assert.deepEqual(doc({ playerIntro: 'On tomorrow!', rules: TEKKEN_RULES }), []);
  assert.match(doc({ rules: 'x'.repeat(3001) }).join(), /marketing\.rules/);
  assert.match(doc({ discordInvite: 'http://discord.gg/abc' }).join(), /marketing\.discordInvite/);
  assert.match(doc('text').join(), /marketing/);
});

test('through the API: HQ saves event.marketing; admins and store teams never receive it and cannot write it', async () => {
  const t = await startTestServer();
  try {
    const hq = await seedBasic(t);
    const a1 = await t.login('AAA2');
    const batch = (cookie: string, id: string, v: unknown) => t.json('/api/batch', { method: 'POST', cookie, body: { id, ops: [{ k: 'events', id: 'e1', p: ['marketing'], v }] } });

    assert.equal((await batch(hq, 'mk-hq-ok-00001', SET)).status, 200);
    assert.deepEqual((await t.json('/api/state', { cookie: hq })).body.events.e1.marketing, SET);
    // the field-level edit path the page uses (a diff of one field) works too
    const one = await t.json('/api/batch', { method: 'POST', cookie: hq, body: { id: 'mk-hq-ok-00002', ops: [{ k: 'events', id: 'e1', p: ['marketing', 'prizePool'], v: '25,000' }] } });
    assert.equal(one.status, 200);
    assert.equal((await t.json('/api/state', { cookie: hq })).body.events.e1.marketing.prizePool, '25,000');

    // an admin of the campaign's store: the event is theirs to read, but not this field
    const seen = (await t.json('/api/state', { cookie: a1 })).body;
    assert.equal(seen.events.e1.name, 'Synthetic Campaign');
    assert.equal(seen.events.e1.marketing, undefined);
    assert.ok(!JSON.stringify(seen).includes('Lock in and queue up'));
    assert.ok(!JSON.stringify(seen).includes('25,000'));
    const w = await batch(a1, 'mk-adm-nope-0001', { prizePool: '1' });
    assert.deepEqual([w.status, w.body.code], [403, 'forbidden']);

    // bad shapes are refused
    for (const [n, v] of [['unknown', { foo: 'x' }], ['long', { prizePool: 'x'.repeat(41) }], ['invite', { discordInvite: 'ftp://x' }], ['type', { firstMatch: 12 }]] as const) {
      const r = await batch(hq, `mk-bad-${n}-0001`, v);
      assert.deepEqual([r.status, r.body.code], [400, 'invalid'], n);
    }
  } finally {
    await t.close();
  }
});
