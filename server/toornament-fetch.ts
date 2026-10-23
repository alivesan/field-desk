import { fetchRoster, RosterFetchError, type RosterFetchOptions } from './roster-fetch.ts';
import {
  bracketFromNodes,
  isToornamentHost,
  PAGE,
  parseToornamentLink,
  pickStage,
  readPage,
  readParticipants,
  readStages,
  readTournament,
  toornamentApi,
  type ToornamentFetch,
  type ToornamentParticipant,
} from '../src/lib/toornament.ts';

/*
 * HQ's Toornament link → the tournament, its stages and the chosen stage's first round
 * (GET /api/toornament/fetch, HQ only). The link HQ pasted is only read for its ids; every
 * request goes to play.toornament.com's public JSON (see src/lib/toornament.ts for what it is)
 * through fetchRoster, so it gets the same protection as a roster link — https only, every hop's
 * addresses checked and pinned, 10 s, 2 MB — and allowHost keeps every hop on toornament.com.
 *
 * Requests per fetch: tournament + stages + participants (≤ 6 pages of 50) + bracket nodes
 * (≤ 3 pages of 128, single-elimination stages only). Toornament caches these for 2 minutes.
 *
 * Errors are RosterFetchError: 400 bad-url (not a toornament tournament link), 404 not-found
 * (no public tournament / stage with that id), 502 upstream (unreachable, slow, odd answer).
 */

const MAX_PARTICIPANT_PAGES = 6;
const MAX_NODE_PAGES = 3;

export async function fetchToornament(link: string, stageId: string | undefined, opts: RosterFetchOptions = {}): Promise<ToornamentFetch> {
  const parsed = parseToornamentLink(link);
  if (typeof parsed === 'string') throw new RosterFetchError(400, 'bad-url', parsed);
  if (stageId !== undefined && !/^\d{1,24}$/.test(stageId)) throw new RosterFetchError(400, 'bad-url', 'That isn’t a Toornament stage id.');
  const now = opts.now ?? Date.now;

  const get = async (url: string, what: string): Promise<unknown> => {
    let text: string;
    try {
      ({ text } = await fetchRoster(url, { ...opts, allowHost: isToornamentHost }));
    } catch (e) {
      if (e instanceof RosterFetchError && e.extra?.status === 404) {
        throw new RosterFetchError(404, 'not-found', `Toornament has no public ${what} with that id — check the link. Private tournaments can’t be read.`);
      }
      if (e instanceof RosterFetchError && e.status === 502) throw new RosterFetchError(502, 'upstream', `Toornament: ${e.message}`, e.extra);
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new RosterFetchError(502, 'upstream', 'Toornament answered with something other than its usual data. Try again in a minute.');
    }
  };
  /** Every page of a list, up to `max` pages. */
  const all = async (url: (offset: number) => string, size: number, max: number, what: string) => {
    const items: unknown[] = [];
    let total = 0;
    for (let page = 0; page < max; page++) {
      const r = await readOrFail(async () => readPage(await get(url(page * size), what)));
      items.push(...r.items);
      total = r.total;
      if (!r.items.length || items.length >= total) break;
    }
    return { items, total };
  };

  const tid = parsed.tournamentId;
  const tournament = await readOrFail(async () => readTournament(await get(toornamentApi.tournament(tid), 'tournament')));
  const stages = await readOrFail(async () => readStages(await get(toornamentApi.stages(tid), 'tournament')));
  const wanted = stageId ?? parsed.stageId;
  if (stageId && !stages.some((s) => s.id === stageId)) throw new RosterFetchError(404, 'not-found', 'That stage isn’t in this tournament any more — pick another one.');
  const stage = pickStage(stages, wanted);

  const reg = await all((o) => toornamentApi.participants(tid, o), PAGE.participants, MAX_PARTICIPANT_PAGES, 'tournament');
  const participants: ToornamentParticipant[] = readParticipants({ items: reg.items });

  let bracket: ToornamentFetch['bracket'] = null;
  if (stage?.supported) {
    const nodes = await all((o) => toornamentApi.nodes(tid, stage.id, o), PAGE.nodes, MAX_NODE_PAGES, 'stage');
    bracket = bracketFromNodes(nodes.items, participants, stage);
  }
  return {
    link: parsed,
    tournament,
    stages,
    stage,
    participants,
    participantsTotal: Math.max(reg.total, participants.length),
    bracket,
    fetchedAt: new Date(now()).toISOString(),
  };
}

/** A reader that throws a plain Error (unexpected JSON) becomes a 502 HQ can read. */
async function readOrFail<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RosterFetchError) throw e;
    throw new RosterFetchError(502, 'upstream', 'Toornament answered in an unexpected format — it may have changed. Try again later, or enter the players another way.');
  }
}
