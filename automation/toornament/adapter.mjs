// Browser-only writes. The caller owns login, durable claims and execution exclusion.
import { id } from './lib.mjs';

const origin = 'https://organizer.toornament.com';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (value, message) => { if (!value) throw Error(message); };
export function state(value, participants) {
  requireThat(value && ['pending', 'completed'].includes(value.status), 'Unsupported lifecycle');
  requireThat(Array.isArray(value.sides) && value.sides.length === 2 && new Set(value.sides.map(s=>s.id)).size === 2, 'Expected two distinct opponent sides');
  const sides = participants.map(p => {
    const side = value.sides?.find(s => s.id === p.id);
    requireThat(side && (side.score === null || Number.isSafeInteger(side.score) && side.score >= 0), 'Missing or invalid score');
    requireThat([null, 'win', 'loss', 'draw'].includes(side.result) && typeof side.forfeit === 'boolean', 'Invalid outcome');
    requireThat(!side.forfeit || (side.score === null && [null,'loss'].includes(side.result)), 'Contradictory forfeit outcome');
    return { id:p.id, score:side.score, result:side.forfeit ? 'loss' : side.result, forfeit:side.forfeit };
  });
  return { status:value.status, sides };
}
export function desiredState(job) {
  const participants = job.participants;
  if (job.kind === 'match.reset') return { status:'pending', sides:participants.map(p => ({id:p.id,score:null,result:null,forfeit:false})) };
  const d = job.desired;
  requireThat(d && ['played','forfeit'].includes(d.outcome) && participants.some(p=>p.id===d.winnerId), 'Explicit winner and outcome required');
  requireThat(d.outcome !== 'forfeit' || participants.some(p=>p.id===d.forfeitingParticipantId && p.id!==d.winnerId), 'Invalid forfeiter');
  if (d.outcome === 'played') {
    const winner = d.scores?.[d.winnerId];
    const loser = d.scores?.[participants.find(p=>p.id!==d.winnerId).id];
    requireThat(Number.isSafeInteger(winner) && Number.isSafeInteger(loser) && winner > loser && loser >= 0, 'Winner must have the higher valid score');
  }
  return state({status:'completed',sides:participants.map(p=>({id:p.id,
    score:d.outcome==='forfeit' ? null : d.scores?.[p.id], result:p.id===d.winnerId?'win':'loss',
    forfeit:d.outcome==='forfeit' && p.id===d.forfeitingParticipantId}))},participants);
}
export function validateJob(job, allowlist) {
  id(job.tournamentId); id(job.stageId);
  requireThat(allowlist.some(s=>s.tournamentId===job.tournamentId && s.stageId===job.stageId), 'Scope is not approved');
  requireThat(['match.result','match.reset','participant.add'].includes(job.kind), 'Unsupported operation');
  requireThat(job.expectedTournamentName && job.expectedStageName, 'Expected scope names required');
  if (job.kind==='participant.add') {
    requireThat(typeof job.name==='string' && job.name.trim()===job.name && job.name.length>0, 'Participant name required');
    requireThat(typeof job.customUserIdentifier==='string' && job.customUserIdentifier.trim().length>0, 'Exact custom user identifier required');
    return;
  }
  id(job.matchId); id(job.publicNodeId);
  requireThat(job.mappingVerified===true && job.matchId===job.publicNodeId, 'Verified equal organizer/public match IDs required');
  requireThat(/^Match #[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(job.toornamentLabel), 'Verified label required');
  requireThat(job.participants?.length===2 && new Set(job.participants.map(p=>p.id)).size===2, 'Two distinct participant IDs required');
  job.participants.forEach(p=>{id(p.id); requireThat(typeof p.name==='string' && p.name.length>0, 'Participant name required');});
  requireThat(job.participants[0].name!==job.participants[1].name, 'Duplicate names require human identity verification');
  state(job.expectedPrevious,job.participants); desiredState(job);
}
export function publicMatch(snapshot, job) {
  requireThat(snapshot.tournamentId===job.tournamentId && snapshot.stageId===job.stageId, 'Public scope mismatch');
  requireThat(snapshot.tournamentName===job.expectedTournamentName && snapshot.stageName===job.expectedStageName, 'Public scope name mismatch');
  const nodes=snapshot.nodes.filter(n=>n.id===job.publicNodeId);
  requireThat(nodes.length===1 && nodes[0].opponents?.length===2, 'Public node missing or ambiguous');
  const node=nodes[0];
  for (const p of job.participants) {
    const matches=snapshot.participants.filter(x=>x.id===p.id && x.name===p.name);
    requireThat(matches.length===1 && node.opponents.some(o=>o.participant?.id===p.id), 'Public participant identity mismatch');
  }
  return state({status:node.status,sides:node.opponents.map(o=>({id:o.participant.id,score:o.score??null,result:o.result??null,forfeit:o.forfeit===true}))},job.participants);
}

// Reads the actual form, including the name in each score input's own section.
async function readForm(page, job) {
  requireThat(page.url()===`${origin}/toornament/tournaments/${job.tournamentId}/matches/${job.matchId}/`, 'Unexpected organizer page (login or redirect)');
  const form=await page.evaluate(()=>{
    const text=document.body.innerText;
    const sides=[0,1].map(index=>{
      const prefix=`match_edit_opponents_${index}_`;
      const score=document.getElementById(prefix+'score');
      const forfeit=document.getElementById(prefix+'forfeit');
      if (!score || !forfeit) throw Error('Unsupported match form');
      let section=score.parentElement;
      while(section && (!section.contains(forfeit) || !section.innerText.trim() || section.querySelector(`#match_edit_opponents_${1-index}_score`))) {
        if(section.querySelector(`#match_edit_opponents_${1-index}_score`)) throw Error('Cannot establish participant sections');
        section=section.parentElement;
      }
      // Expand until names are included, but never across the other opponent.
      const sections=[];
      for(let el=section;el && !el.querySelector(`#match_edit_opponents_${1-index}_score`);el=el.parentElement) sections.push(el.innerText);
      const radios=[...document.querySelectorAll('input[type=radio]')].filter(r=>r.id.startsWith(prefix));
      const options=radios.map(r=>({id:r.id,label:document.querySelector(`label[for="${r.id}"]`)?.textContent.trim(),checked:r.checked}));
      return {sections,score:score.value===''?null:Number(score.value),forfeit:forfeit.checked,options};
    });
    return {text,sides};
  });
  requireThat(form.text.includes(job.toornamentLabel) && !form.text.includes('Match locked'), 'Match label mismatch or locked');
  const seen=new Set();
  const sides=form.sides.map(side=>{
    const matches=job.participants.filter(p=>side.sections.some(t=>t.split('\n').some(line=>line.trim()===p.name)));
    requireThat(matches.length===1 && !seen.has(matches[0].id), 'Organizer participant side mismatch');
    const p=matches[0]; seen.add(p.id);
    requireThat(['W','D','L'].every(label=>side.options.filter(o=>o.label===label).length===1), 'Unsupported outcome controls');
    const selected=side.options.filter(o=>o.checked);
    requireThat(selected.length<=1, 'Ambiguous outcome');
    return {...side,id:p.id,result:({W:'win',D:'draw',L:'loss'})[selected[0]?.label]??null};
  });
  const current=state({status:sides.some(s=>s.result!==null)?'completed':'pending',sides},job.participants);
  return {current,sides};
}

export function createAdapter({page, publicReader, allowlist, checkpoint, sleep=ms=>new Promise(r=>setTimeout(r,ms)), timeoutMs=180000, pollMs=5000}) {
  requireThat(page && typeof publicReader==='function', 'Injected page and public reader required');
  requireThat(Number.isFinite(timeoutMs) && timeoutMs>=0 && Number.isFinite(pollMs) && pollMs>0,'Invalid polling bounds');
  const base=job=>`${origin}/toornament/tournaments/${job.tournamentId}/`;
  const active=signal=>{ if(signal?.aborted) throw Error('Execution cancelled'); };
  async function scope(job, signal) {
    active(signal);
    const snap=await publicReader(job,{signal});
    requireThat(snap.tournamentId===job.tournamentId && snap.stageId===job.stageId && snap.tournamentName===job.expectedTournamentName && snap.stageName===job.expectedStageName,'Public scope mismatch');
    return snap;
  }
  async function poll(job, predicate, signal) {
    const attempts=Math.ceil(timeoutMs/pollMs)+1;
    for(let i=0;i<attempts;i++) {
      active(signal);
      if(i) await sleep(Math.min(pollMs,timeoutMs-(i-1)*pollMs));
      if(await predicate(await scope(job,signal))) return true;
    }
    return false;
  }
  async function execute(job, {signal, checkpoint:saveCheckpoint=checkpoint, readOnly=false}={}) {
    let mayHaveSaved=false;
    try {
      validateJob(job,allowlist);
      const snapshot=await scope(job,signal);
      if(job.kind==='participant.add') {
        requireThat(snapshot.supportsCustomUserIdentifier===true,'Public participant identity cannot verify custom identifier; creation requires human review');
        const candidates=snapshot.participants.filter(p=>p.customUserIdentifier===job.customUserIdentifier);
        requireThat(candidates.length<=1,'Duplicate custom identifier');
        if(candidates.length) {
          requireThat(candidates[0].name===job.name,'Custom identifier/name conflict');
          await page.goto(base(job)+'participants/');
          requireThat(page.url()===base(job)+'participants/' && await page.getByText(job.name,{exact:true}).count()===1,'Organizer participant readback ambiguous');
          return {status:'done',verified:true,reconciled:true,participantId:id(candidates[0].id),observedRemoteIds:{participantId:id(candidates[0].id)},placement:'not-requested'};
        }
        requireThat(job.expectedPrevious?.absent===true && !job.priorAttemptUncertain,'Prior create requires reconciliation');
        requireThat(!readOnly,'Participant is not yet verified; reconciliation cannot create');
        requireThat(snapshot.participants.every(p=>typeof p.customUserIdentifier==='string' || p.customUserIdentifier===null),'Public reader must expose custom identifiers to prevent duplicate creation');
        await page.goto(base(job)+'participants/create');
        requireThat(page.url()===base(job)+'participants/create','Unexpected participant page');
        await page.getByLabel('Player name',{exact:true}).fill(job.name);
        await page.getByLabel('Custom user identifier',{exact:true}).fill(job.customUserIdentifier);
        requireThat(typeof saveCheckpoint==='function','Durable checkpoint required');
        await saveCheckpoint({jobId:job.jobId,phase:'before-save',participantIds:snapshot.participants.map(p=>p.id)});
        active(signal);
        mayHaveSaved=true;
        await page.getByRole('button',{name:'Create',exact:true}).click();
        await page.reload();
        requireThat(await page.getByText(job.name,{exact:true}).count()===1,'Organizer participant readback ambiguous');
        let participantId;
        const verified=await poll(job,s=>{
          const matches=s.participants.filter(p=>p.customUserIdentifier===job.customUserIdentifier);
          requireThat(matches.length<=1,'Duplicate created participant identifier');
          if(matches.length && matches[0].name===job.name) {participantId=id(matches[0].id);return true;} return false;
        },signal);
        return verified?{status:'done',verified:true,participantId,observedRemoteIds:{participantId},placement:'not-requested'}:{status:'needs-human',uncertain:true,code:'PUBLIC_READBACK_TIMEOUT'};
      }
      publicMatch(snapshot,job); // Cross-check IDs before navigating to a writable entity.
      await page.goto(base(job)+`matches/${job.matchId}/`);
      const before=await readForm(page,job);
      const desired=desiredState(job);
      if(equal(before.current,desired)) {
        const verified=await poll(job,s=>equal(publicMatch(s,job),desired),signal);
        return verified?{status:'done',verified:true,reconciled:true,observed:before.current,observedRemoteIds:{matchId:job.matchId}}:{status:'needs-human',uncertain:true,code:'PUBLIC_READBACK_TIMEOUT',observed:before.current};
      }
      requireThat(!readOnly,'Desired organizer state absent; reconciliation cannot write');
      requireThat(!job.priorAttemptUncertain,'Earlier possible save requires read-only reconciliation');
      requireThat(equal(before.current,state(job.expectedPrevious,job.participants)),'Organizer predecessor conflict');
      await page.locator('[data-role="outcome-picker-reset"]').click();
      for(let i=0;i<2;i++) {
        await page.locator(`#match_edit_opponents_${i}_forfeit`).uncheck();
        const wanted=desired.sides.find(s=>s.id===before.sides[i].id);
        await page.locator(`#match_edit_opponents_${i}_score`).fill(wanted.score===null?'':String(wanted.score));
      }
      if(job.kind==='match.result') {
        if(job.desired.outcome==='forfeit') {
          const index=before.sides.findIndex(s=>s.id===job.desired.forfeitingParticipantId);
          await page.locator(`#match_edit_opponents_${index}_forfeit`).check();
        } else {
          const winner=before.sides.find(s=>s.id===job.desired.winnerId);
          await page.locator(`label[for="${winner.options.find(o=>o.label==='W').id}"]`).click();
        }
      }
      requireThat(equal((await readForm(page,job)).current,desired),'Form did not select desired result');
      // Recheck the public identity and predecessor immediately before the single save.
      requireThat(equal(publicMatch(await scope(job,signal),job),state(job.expectedPrevious,job.participants)),'Public predecessor conflict');
      requireThat(typeof saveCheckpoint==='function','Durable checkpoint required');
      await saveCheckpoint({jobId:job.jobId,phase:'before-save',matchId:job.matchId,expectedPrevious:before.current,desired});
      active(signal);
      mayHaveSaved=true;
      await page.getByRole('button',{name:'Update',exact:true}).click();
      await page.reload();
      const observed=(await readForm(page,job)).current;
      requireThat(equal(observed,desired),'Organizer saved state mismatch');
      const verified=await poll(job,s=>equal(publicMatch(s,job),desired),signal);
      return verified?{status:'done',verified:true,observed,observedRemoteIds:{matchId:job.matchId}}:{status:'needs-human',uncertain:true,code:'PUBLIC_READBACK_TIMEOUT',observed};
    } catch(error) {
      const uncertain=mayHaveSaved || job?.priorAttemptUncertain===true;
      return {status:'needs-human',uncertain,code:uncertain?'POSSIBLE_SAVE_RECONCILE':'PRECONDITION_OR_UI_FAILURE',message:error.message};
    }
  }
  return {execute, reconcile:(job,options={})=>execute(job,{...options,readOnly:true})};
}
