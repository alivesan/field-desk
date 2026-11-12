// Public Toornament reads only. This endpoint can lag behind organizer saves.
import { apiUrl, boundedJson, id, readPage } from './lib.mjs';

export function createPublicReader({ allowlist, get = boundedJson }) {
  if (!Array.isArray(allowlist) || !allowlist.length || typeof get !== 'function') throw Error('Approved scope and public JSON reader required.');
  return async job => {
    id(job.tournamentId); id(job.stageId);
    if (!allowlist.some(s => s.tournamentId === job.tournamentId && s.stageId === job.stageId)) throw Error('Public scope is not approved.');
    const scope = { tournamentId:job.tournamentId, stageId:job.stageId, approvedThrowaway:true, manualRecorderAcknowledged:true };
    const tournament = await get(apiUrl(scope, 'tournament'));
    if (id(tournament.id) !== scope.tournamentId || typeof tournament.name !== 'string' || !tournament.name) throw Error('Public tournament mismatch.');
    async function all(kind, limit, maxPages) {
      const items = [];
      for (let page = 0; page < maxPages; page++) {
        const { items:batch, total } = readPage(await get(apiUrl(scope, kind, page * limit)), page * limit, limit);
        items.push(...batch);
        if (items.length === total) return items;
        if (batch.length !== limit) throw Error('Incomplete public pagination.');
      }
      throw Error('Public pagination bound exceeded.');
    }
    const stages = await all('stages', 50, 6);
    const matches = stages.filter(s => s.id === scope.stageId);
    if (matches.length !== 1 || typeof matches[0].name !== 'string' || !matches[0].name) throw Error('Public stage missing or ambiguous.');
    const rawParticipants = await all('participants', 50, 6);
    const rawNodes = await all('nodes', 128, 3);
    const participants = rawParticipants.map(p => ({ id:id(p.id), name:p.name, customUserIdentifier:null }));
    if (participants.some(p => typeof p.name !== 'string' || !p.name) || new Set(participants.map(p => p.id)).size !== participants.length) throw Error('Invalid public participants.');
    const nodes = rawNodes.map(n => ({
      id:id(n.id), status:n.status,
      opponents:(n.opponents || []).map(o => ({
        participant:o.participant == null ? null : { id:id(o.participant.id), name:o.participant.name },
        score:o.score ?? null, result:o.result ?? null, forfeit:o.forfeit === true,
      })),
    }));
    if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw Error('Duplicate public nodes.');
    return {
      tournamentId:scope.tournamentId, stageId:scope.stageId,
      tournamentName:tournament.name, stageName:matches[0].name,
      participants, nodes,
      // The public participants endpoint does not expose the organizer's custom user identifier.
      // Creation is disabled until a strong organizer-side readback is proven.
      supportsCustomUserIdentifier:false,
    };
  };
}
