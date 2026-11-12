// Proposed protocol only: no Field Desk service implements these routes here.
export const PROPOSED_ENDPOINTS = Object.freeze({ claim: '/worker/v1/jobs/claim', heartbeat: '/worker/v1/jobs/heartbeat', checkpoint: '/worker/v1/jobs/checkpoint', ack: '/worker/v1/jobs/ack' });
export function queueConfig(env = process.env) {
  const baseUrl = env.FIELD_DESK_QUEUE_URL, apiKey = env.FIELD_DESK_QUEUE_KEY;
  if (!baseUrl || !apiKey) throw Error('Queue configuration required.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Queue requires a credential-free HTTPS URL.');
  return { baseUrl: url.href.replace(/\/$/, ''), apiKey };
}
export function createQueueClient({ baseUrl, apiKey, fetcher = fetch }) {
  const cfg = queueConfig({ FIELD_DESK_QUEUE_URL: baseUrl, FIELD_DESK_QUEUE_KEY: apiKey });
  const call = async (kind, body) => {
    let r;
    try { r = await fetcher(cfg.baseUrl + PROPOSED_ENDPOINTS[kind], { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000), headers: { 'content-type':'application/json', authorization:`Bearer ${cfg.apiKey}` }, body:JSON.stringify(body) }); }
    catch { throw Object.assign(Error('Queue request outcome unknown.'), { code:'QUEUE_UNCERTAIN' }); }
    if (!r.ok) throw Object.assign(Error('Queue request rejected.'), { code:r.status === 409 ? 'STALE_CLAIM' : 'QUEUE_REJECTED' });
    return r.json();
  };
  return Object.fromEntries(Object.keys(PROPOSED_ENDPOINTS).map(k => [k, body => call(k,body)]));
}
const transient = new Set(['REMOTE_READ_TRANSIENT', 'PRE_SAVE_TRANSIENT']);
export function classifyFailure(error, possibleSave = false) {
  if (possibleSave) return { status:'needs-human', code:'UNCERTAIN_EFFECT' };
  if (transient.has(error?.code)) return { status:'pending', code:error.code };
  return { status:'needs-human', code:'REVIEW_REQUIRED' };
}
export function createWorker({ queue, adapter, allowlist, workerId, executionGuard, now = Date.now, random = Math.random, maxAttempts = 3, maxAgeMs = 86400000, heartbeatMs = 5000 }) {
  if (!queue || !adapter || !workerId || !executionGuard?.acquire || !allowlist?.length) throw Error('Queue, adapter, local scope and execution exclusion required.');
  let busy = false;
  return { async runOnce() {
    if (busy) throw Error('Worker is already processing.');
    busy = true; let release, timer, claim, lost = false, possibleSave = false;
    const abort = new AbortController();
    try {
      // Guard must exclude old browser sessions too, including after a process crash.
      release = await executionGuard.acquire(allowlist);
      if (typeof release !== 'function') throw Error('Execution exclusion unavailable.');
      claim = await queue.claim({ workerId, scopes:allowlist });
      if (!claim) return null;
      const { job, claimToken } = claim;
      const identity = { jobId:job.jobId, payloadHash:job.payloadHash, revision:job.revision, claimToken, workerId };
      const ack = async report => { if (lost) throw Error('Lease lost; reconciliation required.'); return queue.ack({ ...identity, ...report }); };
      if (!allowlist.some(s => s.tournamentId === job.tournamentId && s.stageId === job.stageId)) return ack({status:'needs-human',code:'SCOPE_DENIED'});
      if (!job.jobId || !job.payloadHash || job.origin !== 'field-desk' || job.schemaVersion !== 1 || !Number.isInteger(job.revision) || !['participant.add','match.result','match.reset'].includes(job.kind)) return ack({status:'needs-human',code:'INVALID_ENVELOPE'});
      timer = setInterval(() => { queue.heartbeat(identity).catch(() => { lost = true; abort.abort(); }); }, heartbeatMs);
      timer.unref?.();
      const checkpoint = async () => { if (lost || abort.signal.aborted) throw Error('Lease lost.'); possibleSave = true; await queue.checkpoint({ ...identity, phase:'before-save' }); };
      let result;
      try {
        if (claim.recoveryRequired) {
          if (!adapter.reconcile) result = {status:'needs-human',code:'RECOVERY_REQUIRED'};
          else result = await adapter.reconcile(job, { signal:abort.signal });
          // A recovered attempt is read-only. A new claim is needed to retry.
          if (result.status !== 'done') result = {status:'needs-human',code:'RECOVERY_UNRESOLVED'};
        } else result = await adapter.execute(job, { signal:abort.signal, checkpoint });
      } catch (e) { result = classifyFailure(e, possibleSave); }
      if (result?.status === 'uncertain') result = {status:'needs-human',code:'UNCERTAIN_EFFECT'};
      if (!['done','pending','failed','needs-human'].includes(result?.status)) result = {status:'needs-human',code:'INVALID_ADAPTER_RESULT'};
      if (result.status === 'done' && result.verified !== true) result = {status:'needs-human',code:'VERIFICATION_REQUIRED'};
      if (possibleSave && ['pending','failed'].includes(result.status)) result = {status:'needs-human',code:'UNCERTAIN_EFFECT'};
      if (result.status === 'pending' && !transient.has(result.code)) result = {status:'needs-human',code:'UNCLASSIFIED_RETRY'};
      if (result.status === 'pending') {
        if (claim.attempt >= maxAttempts || now() - Date.parse(job.createdAt) >= maxAgeMs || !Number.isFinite(Date.parse(job.createdAt))) result = {status:'failed',code:'RETRY_LIMIT'};
        else result = {...result,nextAttemptAt:new Date(now()+ Math.min(60000,1000*2**(claim.attempt-1))*(0.75+random()*0.5)).toISOString()};
      }
      // Only fixed codes and minimal mapping evidence cross the reporting boundary.
      return await ack({status:result.status,code:/^[A-Z][A-Z0-9_]{0,63}$/.test(result.code || '') ? result.code : result.status==='done' ? 'VERIFIED' : 'REVIEW_REQUIRED',nextAttemptAt:result.nextAttemptAt, observedRemoteIds:result.observedRemoteIds});
    } finally { clearInterval(timer); abort.abort(); if (release) await release(); busy = false; }
  } };
}
