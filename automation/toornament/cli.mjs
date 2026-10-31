import { readFile, writeFile, realpath, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { config, id, privatePath, organizerUrl, snapshot, compare } from './lib.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../data/toornament');
async function load(name) {
 const path=privatePath(root,name); const actual=await realpath(path); privatePath(await realpath(root),actual);
 return JSON.parse(await readFile(actual,'utf8'));
}
async function save(name,value) { await writeFile(privatePath(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); }
async function main() {
 const [action,...args]=process.argv.slice(2); const expected={login:0,probe:0,inspect:1,record:0,snapshot:1,compare:3};
 if (!(action in expected)||args.length!==expected[action]) throw Error('Usage error');
 for(const a of args) if(action==='inspect' ? !/^[0-9]{1,24}$/.test(a) : !/^[a-zA-Z0-9_-]+\.json$/.test(a)) throw Error('Approved match ID or simple filenames required');
 await mkdir(root, { recursive: true, mode: 0o700 });
 const c=config(await load('approved.local.json'));
 if(action==='snapshot') {await save(args[0],await snapshot(c)); console.log('Private identity-only snapshot saved; scores and results are not captured.'); return;}
 if(action==='compare') {
  const diff=compare(await load(args[0]),await load(args[1]),c); await save(args[2],diff);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).map(([x,y])=>[x,y.length]))])),null,2)); return;
 }
 if(action==='login') {
  const {chromium}=await import('playwright'); const browser=await chromium.launch({headless:false});
  try {
   const context=await browser.newContext(); const page=await context.newPage();
   await page.goto('https://organizer.toornament.com/en_US/login/',{timeout:30000});
   const rl=createInterface({input:process.stdin,output:process.stdout});
   try {await rl.question('Sign in manually in the browser. Never enter credentials here. Press Enter here when signed in: ');} finally {rl.close();}
   await page.goto(organizerUrl(c), { timeout: 30000 });
   if (new URL(page.url()).origin !== 'https://organizer.toornament.com' || !page.url().startsWith(organizerUrl(c))) throw Error('Approved tournament access not verified; no authentication state saved.');
   const state = await context.storageState();
   const temporary = privatePath(root, 'auth-state-' + Date.now() + '.tmp');
   await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
   await rename(temporary, privatePath(root, 'auth-state.json'));
   console.log('Private authentication state saved.');
  } finally {await browser.close();} return;
 }
 await load('auth-state.json');
 if(action==='inspect') {
  const matchId=id(args[0]);
  const publicState=await snapshot(c);
  if(!publicState.nodes.some(node=>node.id===matchId)) throw Error('Match is not in the approved test stage.');
  const {chromium}=await import('playwright'); const browser=await chromium.launch({headless:true});
  try {
   const context=await browser.newContext({storageState:privatePath(root,'auth-state.json')});
   const page=await context.newPage();
   const target=organizerUrl(c)+`matches/${matchId}/`;
   await page.goto(target,{timeout:30000});
   if(!page.url().startsWith(target)) throw Error('Approved match access not verified.');
   const heading=await page.getByRole('heading',{level:1}).innerText();
   const scores=await page.getByRole('spinbutton').count();
   const forfeits=await page.getByRole('checkbox').count();
   const update=await page.getByRole('button',{name:'Update',exact:true}).count();
   if(scores!==2||forfeits!==2||update!==1) throw Error('Result form differs from observed layout.');
   console.log(JSON.stringify({matchId,heading,scores,forfeits,updateButton:update,readOnly:true}));
  } finally {await browser.close();}
  return;
 }
 if(action==='probe') {
  const {chromium}=await import('playwright'); const browser=await chromium.launch({headless:true});
  try {
   const context=await browser.newContext({storageState:privatePath(root,'auth-state.json')});
   const page=await context.newPage(); await page.goto(organizerUrl(c),{timeout:30000});
   const signedIn=page.url().startsWith(organizerUrl(c));
   console.log(signedIn ? 'Saved session opens the approved tournament.' : 'Saved session needs a fresh login.');
   if(!signedIn) process.exitCode=2;
  } finally {await browser.close();}
  return;
 }
 console.log('Human-operated recorder: clicks and navigation are NOT constrained. Stay only in the approved throwaway tournament and stage. Stop if sign-in is requested and use login separately. No unattended mutations are implemented. Expired-session credential entry CAN be recorded; close codegen before signing in.');
 const cli=resolve(dirname(fileURLToPath(import.meta.resolve('playwright/package.json'))),'cli.js');
 const child=spawn(process.execPath,[cli,'codegen','--load-storage',privatePath(root,'auth-state.json'),'--output',privatePath(root,`recording-${Date.now()}.js`),organizerUrl(c)],{stdio:['inherit','ignore','ignore'],shell:false});
 await new Promise((ok,fail)=>{child.on('error',fail);child.on('exit',code=>code===0?ok():fail(Error('Recorder failed')));});
}
main().catch(error=>{console.error(error?.message?.includes('spawn UNKNOWN') ? 'Chromium could not start in this execution environment. Run the documented command in your own PowerShell window.' : 'Operation stopped. Check private configuration, browser installation, session, or public response; no credentials were printed.');process.exitCode=1;});
