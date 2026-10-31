import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicReader } from './public-reader.mjs';

const scope = { tournamentId:'111', stageId:'222' };
const page = items => ({ items, range:{offset:0,length:items.length,total:items.length} });
const get = async url => {
  if (url.includes('/tournaments/')) return { id:'111',name:'Test Cup' };
  if (url.includes('/stages?')) return page([{id:'222',name:'Playoffs'}]);
  if (url.includes('/participants?')) return page([{id:'333',name:'Alice',email:'private@example.invalid',customFieldValues:{x:'secret'}}]);
  return page([{id:'444',status:'completed',opponents:[{participant:{id:'333',name:'Alice'},score:2,result:'win',forfeit:false}]}]);
};
test('public reader returns only required match identity and state',async()=>{
  const read=createPublicReader({allowlist:[scope],get});
  const result=await read(scope);
  assert.equal(result.tournamentName,'Test Cup');
  assert.equal(result.stageName,'Playoffs');
  assert.equal(result.nodes[0].opponents[0].result,'win');
  assert.equal(result.participants[0].customUserIdentifier,null);
  assert.equal(result.supportsCustomUserIdentifier,false);
  assert.equal(JSON.stringify(result).includes('private@example.invalid'),false);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('public reader refuses unapproved stage and ambiguous stage',async()=>{
  const read=createPublicReader({allowlist:[scope],get});
  await assert.rejects(read({...scope,stageId:'999'}),/approved/);
  const bad=createPublicReader({allowlist:[scope],get:async url=>url.includes('/stages?')?page([{id:'222',name:'Playoffs'},{id:'222',name:'Playoffs'}]):get(url)});
  await assert.rejects(bad(scope),/ambiguous/);
});
