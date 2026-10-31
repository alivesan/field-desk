import test from 'node:test';
import assert from 'node:assert/strict';
import {config,id,organizerUrl,apiUrl,readPage,normalizeSnapshot,compare,snapshot,privatePath} from './lib.mjs';
const c={tournamentId:'10000000000000000001',stageId:'10000000000000000002',approvedThrowaway:true,manualRecorderAcknowledged:true};
test('explicit approval and lossless IDs with fixed public endpoints',()=>{
 assert.equal(config(c).tournamentId,c.tournamentId);
 assert.equal(organizerUrl(c), 'https://organizer.toornament.com/toornament/tournaments/' + c.tournamentId + '/');
 for(const bad of [1,10000000000000000001,'https://evil.test','1/2','']) assert.throws(()=>id(bad));
 assert.throws(()=>config({...c,approvedThrowaway:false})); assert.throws(()=>config({...c,manualRecorderAcknowledged:false}));
 assert.equal(new URL(apiUrl(c,'nodes')).hostname,'play.toornament.com'); assert.throws(()=>apiUrl(c,'https://evil.test'));
 assert.throws(()=>privatePath(process.cwd(),'../outside'));
});
test('strict page readback',()=>{
 assert.deepEqual(readPage({items:[],range:{offset:0,length:0,total:0}},0,50),{items:[],total:0});
 for(const body of [{items:[]},{items:[],range:{offset:1,length:0,total:0}},{items:[],range:{offset:0,length:1,total:0}}]) assert.throws(()=>readPage(body,0,50));
});
test('ID comparison and placement changes without names',()=>{
 const before=normalizeSnapshot(c,[{id:'1'},{id:'2'}],[{id:'3',opponents:[{participant:{id:'1',name:'Private'}}]}]);
 const after=normalizeSnapshot(c,[{id:'1'},{id:'4'}],[{id:'3',opponents:[{participant:{id:'4'}}]}]);
 const diff=compare(before,after,c);
 assert.deepEqual(diff.participants,{retained:['1'],removed:['2'],added:['4'],changed:[]});assert.deepEqual(diff.nodes.changed,['3']);
 assert.ok(!JSON.stringify(before).includes('Private'));assert.throws(()=>compare(before,{...after,stageId:'999'},c));
});
test('exact stage and complete bounded snapshots',async()=>{
 const page=items=>({items,range:{offset:0,length:items.length,total:items.length}});
 const get=async url=>url.includes('/tournaments/')?{id:c.tournamentId}:url.includes('/stages?')?page([{id:c.stageId}]):url.includes('/participants?')?page([{id:'1'}]):page([{id:'2',opponents:[]}]);
 assert.equal((await snapshot(c,get)).nodes[0].id,'2');
 await assert.rejects(snapshot(c,async url=>url.includes('/stages?')?page([{id:'999'}]):get(url)));
 await assert.rejects(snapshot(c,async url=>url.includes('/participants?')?{items:[],range:{offset:0,length:0,total:1000}}:get(url)));
});

test('bounded public JSON rejects status, redirects and large bodies', async () => {
 const { boundedJson } = await import('./lib.mjs');
 const url = apiUrl(c, 'tournament');
 await assert.rejects(boundedJson(url, async () => new Response('{}', {status:403, headers:{'content-type':'application/json'}})));
 await assert.rejects(boundedJson(url, async () => new Response('', {status:302, headers:{location:'https://example.test'}})));
 await assert.rejects(boundedJson(url, async () => new Response('x'.repeat(2*1024*1024+1), {headers:{'content-type':'application/json'}})));
 assert.deepEqual(await boundedJson(url, async (request, options) => {
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.method, 'GET');
  return new Response('{"ok":true}', {headers:{'content-type':'application/json'}});
 }), {ok:true});
});
