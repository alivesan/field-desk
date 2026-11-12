import { resolve, relative, isAbsolute } from 'node:path';
export const ID = /^[0-9]{1,24}$/;
export function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw Error('Expected a decimal ID string.'); return value; }
export function config(value) {
  if (!value || value.approvedThrowaway !== true || value.manualRecorderAcknowledged !== true) throw Error('Explicit throwaway approval and manual recorder acknowledgement required.');
  id(value.tournamentId); id(value.stageId);
  return { tournamentId: value.tournamentId, stageId: value.stageId, approvedThrowaway: true, manualRecorderAcknowledged: true };
}
export function privatePath(root, name) {
  const result = resolve(root, name); const rel = relative(root, result);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Private evidence path required.');
  return result;
}
export function organizerUrl(c) { config(c); return `https://organizer.toornament.com/toornament/tournaments/${c.tournamentId}/`; }
export function apiUrl(c, kind, offset = 0) {
  config(c);
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid offset.');
  const base = 'https://play.toornament.com/api/';
  if (kind === 'tournament') return `${base}tournaments/${c.tournamentId}`;
  if (kind === 'stages') return `${base}stages?tournament_ids=${c.tournamentId}&offset=${offset}&limit=50`;
  if (kind === 'participants') return `${base}participants?tournament_ids=${c.tournamentId}&offset=${offset}&limit=50`;
  if (kind === 'nodes') return `${base}bracket-nodes?tournament_ids=${c.tournamentId}&stage_ids=${c.stageId}&offset=${offset}&limit=128`;
  throw Error('Unsupported resource.');
}
export function readPage(body, offset, limit) {
  const r = body?.range;
  if (!Array.isArray(body?.items) || body.items.length > limit || !r || r.offset !== offset || r.length !== body.items.length || !Number.isSafeInteger(r.total) || r.total < offset + body.items.length) throw Error('Unexpected page shape.');
  return { items: body.items, total: r.total };
}
export function normalizeSnapshot(c, participants, nodes) {
  config(c);
  const p = participants.map(x => ({ id: id(x.id) }));
  const n = nodes.map(x => ({ id: id(x.id), participantIds: (x.opponents ?? []).map(o => o.participant == null ? null : id(o.participant.id)), sourceNodeIds: (x.opponents ?? []).map(o => o.sourceNode == null ? null : id(o.sourceNode.id)) }));
  for (const list of [p,n]) if (new Set(list.map(x=>x.id)).size !== list.length) throw Error('Duplicate IDs.');
  return { tournamentId:c.tournamentId, stageId:c.stageId, participants:p, nodes:n };
}
export function compare(before, after, c) {
  config(c);
  for (const s of [before,after]) {
    if (s.tournamentId !== c.tournamentId || s.stageId !== c.stageId) throw Error('Snapshot outside approved scope.');
    for (const x of [...s.participants,...s.nodes]) id(x.id);
  }
  const diff = key => {
    const a = new Map(before[key].map(x=>[x.id,x])); const b = new Map(after[key].map(x=>[x.id,x]));
    return { retained:[...a.keys()].filter(x=>b.has(x)).sort(), removed:[...a.keys()].filter(x=>!b.has(x)).sort(), added:[...b.keys()].filter(x=>!a.has(x)).sort(), changed:[...a.keys()].filter(x=>b.has(x) && JSON.stringify(a.get(x)) !== JSON.stringify(b.get(x))).sort() };
  };
  return { participants:diff('participants'), nodes:diff('nodes') };
}
export async function boundedJson(url, fetcher = fetch) {
  const response = await fetcher(url, { method:'GET', redirect:'error', credentials:'omit', signal:AbortSignal.timeout(10000), headers:{accept:'application/json'} });
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw Error('Public read failed.');
  let size = 0; const chunks=[];
  for await (const chunk of response.body) { size += chunk.length; if (size > 2*1024*1024) { throw Error('Response exceeds bound.'); } chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function snapshot(c, get = boundedJson) {
  config(c);
  const tournament = await get(apiUrl(c,'tournament'));
  if (id(tournament.id) !== c.tournamentId) throw Error('Tournament mismatch.');
  async function all(kind,limit,max) {
    const items=[];
    for (let page=0;page<max;page++) {
      const result=readPage(await get(apiUrl(c,kind,page*limit)),page*limit,limit);
      items.push(...result.items);
      if (items.length === result.total) return items;
      if (result.items.length !== limit) throw Error('Incomplete pagination.');
    }
    throw Error('Pagination bound exceeded; no partial snapshot saved.');
  }
  const stages = await all('stages',50,6);
  if (!stages.some(s=>id(s.id)===c.stageId)) throw Error('Approved stage absent from tournament.');
  return normalizeSnapshot(c, await all('participants',50,6), await all('nodes',128,3));
}
