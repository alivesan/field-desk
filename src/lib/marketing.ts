/*
 * Marketing — the owner's three message templates, filled from a campaign and its stores: the Discord post
 * (one per campaign per weekend, a heading per day), the WhatsApp promo (one per store, sent with the
 * store's poster) and the night-before message to a store's registered players (bracket, map, rules, the
 * admin to call). Anything that isn't known yet stays in the text as "[Toornament link missing]" so it
 * can't be sent unnoticed; `storeIssues` / `playerIssues` / `campaignIssues` say the same in words for the screen.
 * Dates are yyyy-mm-dd strings and are never turned into a Date in local time, so the day can't shift.
 * Pure and Node-loadable (no db.ts, no browser globals).
 */
import type { Admin, EventMarketing, PrintFile, Store, TournamentEvent } from './types.ts';
import { storeWhen, weekdayOf, weekendOf, weekendShort, type Weekend } from './weekends.ts';
import { toornamentBracketPage } from './toornament.ts';

/** The Discord server every WhatsApp promo points to, unless HQ types another. */
export const DISCORD_INVITE = 'https://discord.gg/AeqmQyy3TB';

/** The ROG Showdown's fixed prize pool and times — what the templates say unless HQ types otherwise for a campaign. */
export const PRIZE_POOL = '30,000';
export const REPORTING_TIME = '11:00 AM';
export const FIRST_MATCH = '12:30 PM';

/** The Marketing fields and how long each may be (schema.ts checks them). */
export const MARKETING_MAX = {
  prizePool: 40,
  reportingTime: 60,
  firstMatch: 60,
  discordIntro: 1000,
  discordClosing: 1000,
  whatsappIntro: 1000,
  discordInvite: 300,
  playerIntro: 300,
  rules: 3000,
  discordTemplate: 4000,
  whatsappTemplate: 4000,
  playerTemplate: 4000,
} as const satisfies Record<keyof EventMarketing, number>;

export type TemplateKind = 'discord' | 'whatsapp' | 'player';

/**
 * The stock layouts, as the owner sent them. HQ can rewrite each one per campaign on the Marketing page; a {name} in it is
 * filled per campaign / store (PLACEHOLDERS), anything else is sent as typed.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKind, string> = {
  discord: [
    '@everyone',
    '# ROG SHOWDOWN | {game}',
    '{intro}',
    '**{game} | ₹{prizePool} Prize Pool | FREE ENTRY**',
    'Reporting: **{reportingTime}**\nFirst Match: **{firstMatch}**',
    '{days}',
    '{closing}',
    'Questions? Drop them in the thread.',
  ].join('\n\n'),
  whatsapp: [
    '*ROG SHOWDOWN - {city}*\n*{game} | ₹{prizePool} Prize Pool | Free Entry*\n*Date:* {date}',
    '{intro}',
    '*Venue:* {store}, {city}\n*Game:* {game}\n*Prize Pool:* ₹{prizePool}\n*Reporting Time:* {reportingTime}\n*First Match:* {firstMatch}',
    '*Register Now:* {register}\n*Location:* {map}\n*Discord:* {discordInvite}',
  ].join('\n\n'),
  player: [
    'ROG SHOWDOWN - {city}\n{date}\n{intro}\nVenue: {store}, {city}\nReporting time: {reportingTime}\nFirst match: {firstMatch}',
    'Location: {map}\nBracket: {bracket}\n', // two blank lines before the rules, as in the template
    'TOURNAMENT RULES\nGame: {game}\n{rules}',
    "Admin's decision is final.",
    'Admin contact: {adminName} - {adminPhone}',
    'See you there.',
    'Team La-eGamers',
  ].join('\n\n'),
};

const COMMON = [
  { key: 'game', what: 'the game' },
  { key: 'prizePool', what: 'prize pool, no ₹' },
  { key: 'reportingTime', what: 'reporting time' },
  { key: 'firstMatch', what: 'first match' },
];
const STORE = [
  { key: 'city', what: 'store’s city' },
  { key: 'store', what: 'store’s name' },
  { key: 'date', what: 'its day, “Saturday, 14 November 2026”' },
  { key: 'map', what: 'Maps link' },
];

/** The {placeholders} each template understands, with what they become — the page lists them for HQ. */
export const PLACEHOLDERS: Record<TemplateKind, { key: string; what: string }[]> = {
  discord: [...COMMON, { key: 'intro', what: 'the Discord intro' }, { key: 'days', what: 'each day’s stores with their links' }, { key: 'closing', what: 'the Discord closing' }, { key: 'discordInvite', what: 'Discord invite' }],
  whatsapp: [...COMMON, ...STORE, { key: 'intro', what: 'the WhatsApp paragraph' }, { key: 'register', what: 'Toornament link' }, { key: 'discordInvite', what: 'Discord invite' }],
  player: [...COMMON, ...STORE, { key: 'intro', what: 'the line under the date' }, { key: 'bracket', what: 'Toornament bracket page' }, { key: 'rules', what: 'the rules' }, { key: 'adminName', what: 'admin to call' }, { key: 'adminPhone', what: 'their number' }],
};

/** Where each template is kept on the campaign. */
export const TEMPLATE_FIELD = { discord: 'discordTemplate', whatsapp: 'whatsappTemplate', player: 'playerTemplate' } as const satisfies Record<TemplateKind, keyof EventMarketing>;

/** The campaign's template of that kind: HQ's own, else the stock one. */
export const templateOf = (kind: TemplateKind, opts: EventMarketing = {}) => text(opts[TEMPLATE_FIELD[kind]]) || DEFAULT_TEMPLATES[kind];

/** The {names} in a template that the kind doesn't know (a typo, most likely); they are sent as typed. */
export function unknownPlaceholders(kind: TemplateKind, template: string) {
  const known = new Set(PLACEHOLDERS[kind].map((p) => p.key));
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((k) => !known.has(k));
}

/** Fills each {name} that `values` has; anything else stays as typed. */
export const fillTemplate = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, k: string) => (Object.hasOwn(values, k) ? values[k] : all));

/** Discord refuses a message over this (without Nitro); the screen warns when a post is longer. */
export const DISCORD_LIMIT = 2000;

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Saturday, 31 October" */
export function longDay(date: string) {
  const [, m, d] = date.split('-').map(Number);
  return `${DAY[weekdayOf(date)]}, ${d} ${MONTH[m - 1]}`;
}

/** "Saturday, 31 October 2026" */
export const longDate = (date: string) => `${longDay(date)} ${date.slice(0, 4)}`;

/** The game(s) of a campaign: the first game, "A / B" for several, the campaign's name when none. */
export function gameName(event: Pick<TournamentEvent, 'games' | 'name'>) {
  const games = event.games.map((g) => g.trim()).filter(Boolean);
  return games.length ? games.join(' / ') : event.name.trim();
}

/** A store's event day. */
export const dayOf = (store: Pick<Store, 'date'>, event: Pick<TournamentEvent, 'date'>) => store.date || event.date;

/** The words in the box when HQ hasn't written its own. */
export const defaultDiscordIntro = (game: string) => `ROG Showdown is back with ${game}! Gather your squad, show up at your nearest ROG store and play for the prize pool.`;
export const defaultDiscordClosing = (game: string) => `Bring your A-game and your teammates — see you on the ${game} stage!`;
export const defaultWhatsappIntro = (game: string) =>
  `ROG Showdown is coming to your city! Join the ${game} tournament at your nearest ROG store, play on gaming PCs and compete for the prize pool. Entry is free, so bring your squad and register now!`;
export const defaultPlayerIntro = (game: string) => `Your ${game} tournament is on tomorrow — here’s everything you need.`;

/** The owner's Tekken 8 rules, as sent to players. */
export const TEKKEN_RULES = [
  '– Format: Single Elimination until Semis',
  '– Match format: 1v1, First to 3 Rounds (BO1 Set) in all rounds until Semifinals',
  '– Semifinals & Finals: Best of 3 Sets (First to 2 Games), each game First to 3 Rounds',
  '– Game Mode: Tournament/Versus',
  '– Stage: Random select every game; loser can change character and request random stage',
  '– Winner must keep character, loser can switch',
  '– Only preset costumes allowed (no customs)',
  '– Controller - Game play | ARCADE stick allowed if your opponent allows',
  '– No Keyboard Play',
  '– winners of event from one city cant participate in other cities',
].join('\n');

/** The rules a campaign starts with: the Tekken rules for a Tekken campaign; none for another game (HQ types them). */
export const defaultRules = (game: string) => (/tekken/i.test(game) ? TEKKEN_RULES : '');

/** What HQ typed, tidied, with the defaults filled in. `prizePool` has no leading ₹ (the templates add it). */
export interface MarketingText {
  prizePool: string;
  reportingTime: string;
  firstMatch: string;
  discordIntro: string;
  discordClosing: string;
  whatsappIntro: string;
  discordInvite: string;
  playerIntro: string;
  rules: string;
}

const text = (v: string | undefined) => (v ?? '').trim();
const missing = (what: string) => `[${what} missing]`;

/** The campaign's marketing settings as the templates use them; an empty field becomes its default (the fixed prize pool and times, a stock text), or a "[… missing]" marker when there is none. */
export function marketingText(event: Pick<TournamentEvent, 'games' | 'name'>, opts: EventMarketing = {}): MarketingText {
  const game = gameName(event);
  return {
    prizePool: text(opts.prizePool).replace(/^₹\s*/, '') || PRIZE_POOL,
    reportingTime: text(opts.reportingTime) || REPORTING_TIME,
    firstMatch: text(opts.firstMatch) || FIRST_MATCH,
    discordIntro: text(opts.discordIntro) || defaultDiscordIntro(game),
    discordClosing: text(opts.discordClosing) || defaultDiscordClosing(game),
    whatsappIntro: text(opts.whatsappIntro) || defaultWhatsappIntro(game),
    discordInvite: text(opts.discordInvite) || DISCORD_INVITE,
    playerIntro: text(opts.playerIntro) || defaultPlayerIntro(game),
    rules: text(opts.rules) || defaultRules(game) || missing('Rules'),
  };
}

/** What is still missing about the campaign itself, in words for the screen: only the rules can be (a game without stock rules, when the players' template uses them). */
export function campaignIssues(event: Pick<TournamentEvent, 'games' | 'name'>, opts: EventMarketing = {}) {
  return [!text(opts.rules) && !defaultRules(gameName(event)) && templateOf('player', opts).includes('{rules}') && 'No rules'].filter(Boolean) as string[];
}

/** What is still missing about one store, in words for the screen. */
export function storeIssues(store: Pick<Store, 'city' | 'mapsUrl' | 'toornament'>) {
  return [!text(store.city) && 'No city', !text(store.toornament?.url) && 'No Toornament link', !text(store.mapsUrl) && 'No Maps link'].filter(Boolean) as string[];
}

const city = (s: Pick<Store, 'city'>) => text(s.city) || missing('City');
const register = (s: Pick<Store, 'toornament'>) => text(s.toornament?.url) || missing('Toornament link');
const gmap = (s: Pick<Store, 'mapsUrl'>) => text(s.mapsUrl) || missing('Maps link');

/**
 * The Discord post for one campaign's stores (one weekend): a heading per distinct day, oldest first, the stores of a day by city then
 * name. Stores without a Toornament / Maps link keep a "[… missing]" marker where the link goes.
 */
export function discordPost(event: TournamentEvent, stores: Store[], opts: EventMarketing = event.marketing ?? {}) {
  const m = marketingText(event, opts);
  const days = new Map<string, Store[]>();
  for (const s of [...stores].sort((a, b) => city(a).localeCompare(city(b)) || a.name.localeCompare(b.name))) {
    const d = dayOf(s, event);
    days.set(d, [...(days.get(d) ?? []), s]);
  }
  const sections = [...days.keys()].sort().map((d) => {
    const blocks = days.get(d)!.map((s) => [`**${city(s)} — ${s.name}**`, `Register: <${register(s)}>`, `Gmap: <${gmap(s)}>`].join('\n'));
    return [`## ${longDay(d)}`, ...blocks].join('\n\n');
  });
  return fillTemplate(templateOf('discord', opts), { ...common(event, m), intro: m.discordIntro, days: sections.join('\n\n'), closing: m.discordClosing, discordInvite: m.discordInvite });
}

const common = (event: Pick<TournamentEvent, 'games' | 'name'>, m: MarketingText) => ({ game: gameName(event), prizePool: m.prizePool, reportingTime: m.reportingTime, firstMatch: m.firstMatch });
const storeValues = (event: TournamentEvent, s: Store) => ({ city: city(s), store: s.name, date: longDate(dayOf(s, event)), map: gmap(s) });

/** The WhatsApp promo for one store (sent with its poster). */
export function whatsappPromo(event: TournamentEvent, store: Store, opts: EventMarketing = event.marketing ?? {}) {
  const m = marketingText(event, opts);
  return fillTemplate(templateOf('whatsapp', opts), { ...common(event, m), ...storeValues(event, store), intro: m.whatsappIntro, register: register(store), discordInvite: m.discordInvite });
}

/** The store's bracket on Toornament (the /stages/ page, not the registration page), or a marker. */
const bracket = (s: Pick<Store, 'toornament'>) => (text(s.toornament?.url) ? toornamentBracketPage(text(s.toornament!.url), s.toornament!.stageId) : missing('Bracket link'));

/**
 * Who the players' message says to call: what HQ typed on the store's card, else the assigned admin (the admin record when HQ
 * has it, else the name copied onto the store). A typed name with no number never borrows the assigned admin's number.
 */
export function adminOf(store: Pick<Store, 'adminId' | 'admin' | 'playerContact'>, admins: Record<string, Admin>) {
  const a = store.adminId ? admins[store.adminId] : undefined;
  const typed = { name: text(store.playerContact?.name), phone: text(store.playerContact?.phone) };
  return { name: typed.name || text(a?.name) || text(store.admin), phone: typed.phone || (typed.name ? '' : text(a?.phone)) };
}

/** What the night-before message to one store's players is still missing, in words for the screen. */
export function playerIssues(store: Pick<Store, 'city' | 'mapsUrl' | 'toornament' | 'adminId' | 'admin' | 'playerContact'>, admins: Record<string, Admin>) {
  const a = adminOf(store, admins);
  return [!text(store.city) && 'No city', !text(store.toornament?.url) && 'No bracket link', !text(store.mapsUrl) && 'No Maps link', !a.name && 'No admin', !!a.name && !a.phone && 'No admin phone'].filter(Boolean) as string[];
}

/** The message sent the night before to a store's registered players: where, when, the bracket, the rules and the admin to call. */
export function playerMessage(event: TournamentEvent, store: Store, admins: Record<string, Admin>, opts: EventMarketing = event.marketing ?? {}) {
  const m = marketingText(event, opts);
  const a = adminOf(store, admins);
  return fillTemplate(templateOf('player', opts), {
    ...common(event, m),
    ...storeValues(event, store),
    intro: m.playerIntro,
    bracket: bracket(store),
    rules: m.rules,
    adminName: a.name || missing('Admin'),
    adminPhone: a.phone || missing('Admin phone'),
  });
}

/** The store's poster from its print kit, if the kit has one. */
export const posterOf = (store: Pick<Store, 'print'>): PrintFile | undefined => store.print?.files.find((f) => f.kind === 'poster');

export interface MarketingCampaign {
  event: TournamentEvent;
  /** The campaign's stores playing that weekend, by day, then city, then name. */
  stores: Store[];
}

export interface MarketingWeekend {
  when: 'this' | 'next' | 'later';
  /** "This weekend" / "This week" / "Next weekend" / "Next week" / "Later" */
  title: string;
  /** "Sat 7 – Sun 8 Nov" */
  label: string;
  weekend: Weekend;
  campaigns: MarketingCampaign[];
  /** How many stores play that weekend, across its campaigns. */
  storeCount: number;
}

/**
 * Every weekend (or week) from now on with stores playing, nearest first: what is left of this week, the next one, then later ones,
 * each grouped by campaign (by name). A week with no stores isn't listed; past stores are left out.
 * `today` is passed in (yyyy-mm-dd), so nothing here reads a clock.
 */
export function marketingWeekends(state: { events: Record<string, TournamentEvent>; stores: Record<string, Store> }, today: string): MarketingWeekend[] {
  const day = (s: Store) => dayOf(s, state.events[s.eventId]);
  const rows = Object.values(state.stores)
    .filter((s) => state.events[s.eventId] && storeWhen(day(s), today) !== 'past')
    .sort((a, b) => day(a).localeCompare(day(b)) || city(a).localeCompare(city(b)) || a.name.localeCompare(b.name));
  const weeks = new Map<string, Store[]>();
  for (const s of rows) {
    const sat = weekendOf(day(s)).sat;
    weeks.set(sat, [...(weeks.get(sat) ?? []), s]);
  }
  return [...weeks.values()].map((week) => {
    const campaigns: MarketingCampaign[] = [];
    for (const s of week) {
      const found = campaigns.find((c) => c.event.id === s.eventId);
      if (found) found.stores.push(s);
      else campaigns.push({ event: state.events[s.eventId], stores: [s] });
    }
    campaigns.sort((a, b) => a.event.name.localeCompare(b.event.name));
    const when = storeWhen(day(week[0]), today) as MarketingWeekend['when'];
    const span = week.every((s) => [0, 6].includes(weekdayOf(day(s)))) ? 'weekend' : 'week';
    const weekend = weekendOf(day(week[0]));
    return {
      when,
      title: when === 'this' ? `This ${span}` : when === 'next' ? `Next ${span}` : 'Later',
      label: weekendShort(weekend),
      weekend,
      campaigns,
      storeCount: week.length,
    };
  });
}
