// In-memory reference for the PROPOSED protocol; never a production queue.
export class MockQueue {
  constructor({now = Date.now, leaseMs = 30000} = {}) { this.now=now; this.leaseMs=leaseMs; this.jobs=new Map(); this.sequence=0; }
  enqueue(job) {
    const old=this.jobs.get(job.jobId);
    if(old) { if(JSON.stringify(old.job)!==JSON.stringify(job)) throw Object.assign(Error('Immutable job conflict.'),{code:'CONFLICT'}); return old; }
    const item={job:structuredClone(job),status:'pending',attempt:0,history:[]}; this.jobs.set(job.jobId,item); return item;
  }
  async claim({workerId,scopes}) {
    for(const item of this.jobs.values()) {
      if(!scopes.some(s=>s.tournamentId===item.job.tournamentId&&s.stageId===item.job.stageId)) continue;
      if(item.status!=='pending' && !(item.status==='claimed'&&item.expiresAt<=this.now())) continue;
      if([...this.jobs.values()].some(other=>other!==item&&other.status==='claimed'&&other.expiresAt>this.now()&&other.job.tournamentId===item.job.tournamentId&&other.job.stageId===item.job.stageId)) continue;
      if(item.nextAttemptAt && Date.parse(item.nextAttemptAt)>this.now()) continue;
      // A later entity revision cannot jump a predecessor.
      if(item.job.expectedPreviousRevision>0 && ![...this.jobs.values()].some(p=>p.job.entityId===item.job.entityId&&p.job.tournamentId===item.job.tournamentId&&p.job.stageId===item.job.stageId&&p.job.bracketGenerationId===item.job.bracketGenerationId&&p.job.revision===item.job.expectedPreviousRevision&&p.status==='done')) continue;
      const recoveryRequired=item.status==='claimed'||item.possibleSave===true;
      item.status='claimed'; item.claimToken=String(++this.sequence);item.workerId=workerId;item.expiresAt=this.now()+this.leaseMs;item.attempt++;
      return {job:structuredClone(item.job),claimToken:item.claimToken,attempt:item.attempt,recoveryRequired};
    } return null;
  }
  current(b) { const i=this.jobs.get(b.jobId); if(!i||i.status!=='claimed'||i.claimToken!==b.claimToken||i.workerId!==b.workerId||i.expiresAt<=this.now()||i.job.payloadHash!==b.payloadHash||i.job.revision!==b.revision) throw Object.assign(Error('Stale claim.'),{code:'STALE_CLAIM'}); return i; }
  async heartbeat(b) { const i=this.current(b);i.expiresAt=this.now()+this.leaseMs;return {expiresAt:i.expiresAt}; }
  async checkpoint(b) { const i=this.current(b);i.possibleSave=true;return {recorded:true}; }
  async ack(b) { const i=this.current(b);if(!['pending','done','failed','needs-human'].includes(b.status)) throw Error('Invalid status.'); i.status=b.status;i.nextAttemptAt=b.nextAttemptAt;i.history.push(structuredClone(b));return {status:i.status}; }
}
export function createMockExecutionGuard() {
  let held=false;
  return {async acquire() {if(held) throw Error('Browser execution already held.');held=true;return async()=>{held=false;};}};
}
