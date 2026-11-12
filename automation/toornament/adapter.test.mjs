import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, desiredState, publicMatch, validateJob } from './adapter.mjs';

const participants=[{id:'11',name:'Alice'},{id:'12',name:'Bob'}];
const pending={status:'pending',sides:participants.map(p=>({id:p.id,score:null,result:null,forfeit:false}))};
const job={jobId:'job-1',kind:'match.result',tournamentId:'1',stageId:'2',matchId:'3',publicNodeId:'3',mappingVerified:true,
  expectedTournamentName:'Cup',expectedStageName:'Playoffs',toornamentLabel:'Match #1.1.1.1',participants,expectedPrevious:pending,
  desired:{outcome:'played',winnerId:'12',scores:{11:1,12:2}}};
const allowlist=[{tournamentId:'1',stageId:'2'}];
const snapshot={tournamentId:'1',stageId:'2',tournamentName:'Cup',stageName:'Playoffs',participants,supportsCustomUserIdentifier:true,
  nodes:[{id:'3',status:'pending',opponents:participants.map(participant=>({participant,score:null,result:null}))}]};

test('winner and score mapping follow IDs in either orientation',()=>{
  const result=desiredState(job);
  assert.deepEqual(result.sides,[{id:'11',score:1,result:'loss',forfeit:false},{id:'12',score:2,result:'win',forfeit:false}]);
  assert.deepEqual(desiredState({...job,participants:[...participants].reverse()}).sides,[...result.sides].reverse());
  assert.throws(()=>desiredState({...job,desired:{outcome:'played',winnerId:'11',scores:{11:1,12:2}}}),/higher/);
});
test('forfeit clears scores and assigns only the losing side forfeit',()=>{
  const result=desiredState({...job,desired:{outcome:'forfeit',winnerId:'11',forfeitingParticipantId:'12'}});
  assert.deepEqual(result.sides,[{id:'11',score:null,result:'win',forfeit:false},{id:'12',score:null,result:'loss',forfeit:true}]);
  assert.throws(()=>desiredState({...job,desired:{outcome:'forfeit',winnerId:'11',forfeitingParticipantId:'11'}}));
  assert.throws(()=>publicMatch({...snapshot,nodes:[{id:'3',status:'completed',opponents:[
    {participant:participants[0],score:null,result:'loss',forfeit:false},
    {participant:participants[1],score:null,result:'win',forfeit:true},
  ]}]},job),/Contradictory/);
});
test('reset explicitly removes outcomes, forfeits and both scores',()=>{
  assert.deepEqual(desiredState({...job,kind:'match.reset'}),pending);
});
test('unapproved scopes and guessed mappings fail closed',()=>{
  validateJob(job,allowlist);
  for(const change of [{stageId:'9'},{matchId:'4'},{mappingVerified:false},{participants:[participants[0],{id:'12',name:'Alice'}]}]) {
    assert.throws(()=>validateJob({...job,...change},allowlist));
  }
});
test('public cross-check rejects same-name replacement IDs and ambiguous nodes',()=>{
  assert.deepEqual(publicMatch(snapshot,job),pending);
  assert.throws(()=>publicMatch({...snapshot,participants:[{id:'99',name:'Alice'},participants[1]]},job));
  assert.throws(()=>publicMatch({...snapshot,nodes:[...snapshot.nodes,...snapshot.nodes]},job));
  assert.throws(()=>publicMatch({...snapshot,stageName:'Other'},job));
});
test('malformed score never reaches a browser',async()=>{
  let navigated=false;
  const adapter=createAdapter({page:{goto(){navigated=true;}},allowlist,publicReader:async()=>snapshot,checkpoint:async()=>{}});
  const result=await adapter.execute({...job,desired:{...job.desired,scores:{11:'1',12:2}}});
  assert.equal(result.status,'needs-human'); assert.equal(result.uncertain,false); assert.equal(navigated,false);
});
test('participant reconciliation requires custom identifier, never name alone',async()=>{
  const add={...job,kind:'participant.add',name:'Alice',customUserIdentifier:'fielddesk:entry:7',expectedPrevious:{absent:true}};
  let currentUrl;
  const page={goto:async url=>{currentUrl=url;},url:()=>currentUrl,getByText:()=>({count:async()=>1})};
  const adapter=createAdapter({page,allowlist,checkpoint:async()=>{},publicReader:async()=>({...snapshot,participants:[{id:'11',name:'Alice',customUserIdentifier:'fielddesk:entry:7'}]})});
  assert.deepEqual(await adapter.execute(add),{status:'done',verified:true,reconciled:true,participantId:'11',observedRemoteIds:{participantId:'11'},placement:'not-requested'});
  const conflict=await adapter.execute({...add,name:'Bob'});
  assert.equal(conflict.status,'needs-human');assert.equal(conflict.uncertain,false);
});
test('real public reader cannot prove custom identifier, so participant creation stops before navigation',async()=>{
  let navigated=false;
  const adapter=createAdapter({page:{goto(){navigated=true;}},allowlist,publicReader:async()=>({...snapshot,supportsCustomUserIdentifier:false})});
  const add={...job,kind:'participant.add',name:'Alice',customUserIdentifier:'fielddesk:entry:7',expectedPrevious:{absent:true}};
  const result=await adapter.execute(add);
  assert.equal(result.status,'needs-human');
  assert.equal(result.uncertain,false);
  assert.equal(navigated,false);
});
test('reconciliation never creates and cancellation stops before navigation',async()=>{
  let navigated=false;
  const adapter=createAdapter({page:{goto(){navigated=true;}},allowlist,publicReader:async()=>({...snapshot,participants:[]})});
  const add={...job,kind:'participant.add',name:'Alice',customUserIdentifier:'fielddesk:entry:7',expectedPrevious:{absent:true}};
  assert.equal((await adapter.reconcile(add)).status,'needs-human');
  const controller=new AbortController();controller.abort();
  assert.equal((await adapter.execute(add,{signal:controller.signal})).status,'needs-human');
  assert.equal(navigated,false);
});
test('an uncertain participant create cannot be retried from an empty public cache',async()=>{
  let navigated=false;
  const adapter=createAdapter({page:{goto(){navigated=true;}},allowlist,checkpoint:async()=>{},publicReader:async()=>({...snapshot,participants:[]})});
  const result=await adapter.execute({...job,kind:'participant.add',name:'Alice',customUserIdentifier:'fielddesk:entry:7',expectedPrevious:{absent:true},priorAttemptUncertain:true});
  assert.equal(result.status,'needs-human');assert.equal(result.uncertain,true);assert.equal(navigated,false);
});
test('a save click failure remains uncertain and the durable checkpoint precedes it',async()=>{
  const events=[];let currentUrl;
  const page={goto:async url=>{currentUrl=url;},url:()=>currentUrl,
    getByLabel:()=>({fill:async()=>{}}),getByRole:()=>({click:async()=>{events.push('save');throw Error('Navigation interrupted');}})};
  const adapter=createAdapter({page,allowlist,publicReader:async()=>({...snapshot,participants:[]})});
  const result=await adapter.execute({...job,kind:'participant.add',name:'Alice',customUserIdentifier:'fielddesk:entry:7',expectedPrevious:{absent:true}},
    {checkpoint:async()=>{events.push('checkpoint');}});
  assert.deepEqual(events,['checkpoint','save']);
  assert.equal(result.status,'needs-human');assert.equal(result.uncertain,true);assert.equal(result.verified,undefined);
});
