import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TTL, digest, normalize, parseEmail, matchAccount, eligibleStores, verifySignature } from './core.mjs';

const safeReasons = new Set(['invalid_message','invalid_provider','expired_or_invalid_time','sender_rejected','sender_auth_unverified','forward_origin_unverified','original_date_unverified','account_name_missing','not_guard_email','ambiguous_or_missing_code','ambiguous_account_name','invalid_accounts_response','unmatched_or_ambiguous_account','fielddesk_unavailable','no_active_request','outside_lookup_window','superseded_scan','older_than_selected','invalid_delivery_response']);
const lower = value => String(value || '').trim().toLowerCase();
const validId = value => typeof value === 'string' && /^[\x21-\x7e]{1,200}$/.test(value);
const compare = (a, b) => a.sent - b.sent || a.arrived - b.arrived || a.id.localeCompare(b.id);
const slotId = lookup => digest(lookup.storeId ? `store\0${lookup.storeId}` : `legacy-account\0${lookup.username}`);
const lookupKey = lookup => digest(lookup.requestId || `legacy\0${lookup.username}\0${lookup.storeId || ''}`);
const storeIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200);

export async function createService({ statePath, mailboxes, baseUrl, apiKey, webhookSecret, fetchImpl = fetch, now = Date.now }) {
  for (const box of mailboxes) {
    for (const name of ['requestOnly', 'allowRequestedRedirects']) if (box[name] !== undefined && typeof box[name] !== 'boolean') throw new Error('invalid_mailbox_policy');
    if (box.allowRequestedRedirects && box.requestOnly !== true) throw new Error('redirects_require_request_only');
  }
  let state = { delivered: {}, events: {}, boosts: {}, polls: {}, issues: [] };
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('state_unreadable'); }
  for (const key of ['delivered','events','boosts','polls']) if (!state[key] || typeof state[key] !== 'object') throw new Error('invalid_state');
  if (!Array.isArray(state.issues)) throw new Error('invalid_state');
  for (const key of ['closedRequests', 'latest']) {
    state[key] ??= {};
    if (typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error('invalid_state');
  }
  // Re-key old account-scoped windows without losing active watches or ledgers.
  const migrated = {};
  for (const boost of Object.values(state.boosts)) {
    boost.requestedAt ??= boost.until - TTL;
    boost.acceptFrom ??= boost.requestedAt - 60_000;
    migrated[lookupKey(boost)] = boost;
    state.latest[slotId(boost)] ??= { at: boost.requestedAt, until: boost.until };
  }
  state.boosts = migrated;
  state.lookupSchemaVersion = 2;
  const save = async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
  };
  const prune = () => {
    for (const key of ['delivered','events']) for (const [id, time] of Object.entries(state[key])) if (now() - time > 86400_000) delete state[key][id];
    for (const key of ['boosts','closedRequests','latest']) for (const [id, entry] of Object.entries(state[key])) if (!entry || typeof entry !== 'object' || entry.until <= now()) delete state[key][id];
    state.issues = state.issues.filter(i => now() - i.at < 86400_000).slice(-100);
  };
  let queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const fd = async (path, options = {}) => {
    let response;
    try { response = await fetchImpl(`${baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...options.headers } }); }
    catch { throw new Error('fielddesk_unavailable'); }
    if (!response.ok) throw new Error('fielddesk_unavailable');
    return response;
  };
  const mailbox = id => mailboxes.find(m => m.id === id);
  const scanId = boost => boost.requestId || `legacy:${lookupKey(boost)}`;
  const fixtureBlocked = input => (input.mockOnly === true || input.message?.id?.startsWith('mock-demo-') || input.message?.id === 'synthetic-demo') && !/^http:\/\/(?:mock|127\.0\.0\.1|localhost)(?::\d+)?\/api\/v1\/?$/.test(baseUrl);
  const prepare = input => {
    const box = mailbox(input.mailbox);
    if (!box || input.provider !== box.provider) throw new Error('invalid_provider');
    const email = normalize(input.provider, input.message);
    const id = digest(`${box.id}\0${email.id}`);
    const requestedUsernames = Object.values(state.boosts).filter(boost => boost.until > now()).map(boost => boost.username);
    const parsed = parseEmail(email, now(), { trustedForwarders: box.trustedForwarders || [], allowRequestedRedirects: box.allowRequestedRedirects === true, requestedUsernames });
    let lookups = Object.entries(state.boosts).filter(([, lookup]) => lookup.username === parsed.username && lookup.until > now());
    if (box.requestOnly && !lookups.length) throw new Error('no_active_request');
    const rank = { sent: Date.parse(parsed.receivedAt), arrived: Date.parse(email.receivedAt), id };
    if (lookups.length) {
      lookups = lookups.filter(([, lookup]) => rank.sent >= lookup.acceptFrom && rank.sent < lookup.until);
      if (!lookups.length) throw new Error('outside_lookup_window');
      if (input.requestIds !== undefined) {
        lookups = lookups.filter(([, lookup]) => Array.isArray(input.requestIds) && input.requestIds.includes(scanId(lookup)));
        if (!lookups.length) throw new Error('superseded_scan');
      }
      lookups = lookups.filter(([, lookup]) => !lookup.newest || compare(rank, lookup.newest) >= 0);
      if (!lookups.length) throw new Error('older_than_selected');
      lookups.sort((a, b) => a[1].requestedAt - b[1].requestedAt || a[0].localeCompare(b[0]));
    }
    return { box, email, id, parsed, lookups, rank };
  };
  const failure = async (input, error) => {
    const reason = safeReasons.has(error.message) ? error.message : 'processing_failed';
    const id = typeof input.message?.id === 'string' ? digest(`${input.mailbox}\0${input.message.id}`) : undefined;
    if (!state.issues.some(i => i.messageHash === id && i.reason === reason && i.mailbox === input.mailbox)) state.issues.push({ mailbox: input.mailbox, messageHash: id, reason, at: now() });
    await save();
    return { status: 200, body: { status: reason, markProcessed: false } };
  };
  const closeCurrent = (boostId, boost) => {
    if (state.boosts[boostId] === boost) delete state.boosts[boostId];
    if (boost.requestId) state.closedRequests[digest(boost.requestId)] = { until: Math.max(boost.until, now() + TTL) };
  };
  const processOne = async input => {
    prune();
    if (fixtureBlocked(input)) return { status: 400, body: { status: 'mock_only_blocked', markProcessed: false } };
    const box = mailbox(input.mailbox);
    if (!box || input.provider !== box.provider) return { status: 400, body: { error: 'mailbox_provider_mismatch' } };
    try {
      const emailId = input.message?.id;
      const id = typeof emailId === 'string' ? digest(`${box.id}\0${emailId}`) : null;
      if (id && state.delivered[id]) return { status: 200, body: { status: 'already_delivered', markProcessed: true, messageId: emailId } };
      const item = prepare(input), { parsed, rank } = item;
      for (const [, lookup] of item.lookups) lookup.newest = rank;
      if (item.lookups.length) await save();
      const accounts = await (await fd('/steam/accounts')).json();
      const account = matchAccount(parsed, accounts), holders = eligibleStores(account);
      const valid = item.lookups.filter(([, lookup]) => !lookup.storeId || holders.includes(lookup.storeId));
      if (box.requestOnly && !valid.length) throw new Error('unmatched_or_ambiguous_account');
      valid.sort((a, b) => Number(Boolean(b[1].requestId)) - Number(Boolean(a[1].requestId)) || a[1].requestedAt - b[1].requestedAt || a[0].localeCompare(b[0]));
      const [boostId, boost] = valid[0] || [];
      const checkRequest = () => {
        if (boost && (state.boosts[boostId] !== boost || boost.until <= now())) throw new Error('no_active_request');
        if (box.requestOnly && !boost) throw new Error('no_active_request');
      };
      if (now() - Date.parse(parsed.receivedAt) >= TTL) throw new Error('expired_or_invalid_time');
      checkRequest();
      const response = await fd('/steam/otp', { method: 'POST', headers: { 'Idempotency-Key': `steam-email-${item.id}` }, body: JSON.stringify({ accountUsername: account.username, code: parsed.code, receivedAt: parsed.receivedAt, ...(boost?.requestId ? { requestId: boost.requestId } : {}) }) });
      let result;
      try { result = await response.json(); } catch { throw new Error('invalid_delivery_response'); }
      const request = result?.request;
      if (boost?.requestId && request && (request.id !== boost.requestId || !['open','closed','unknown'].includes(request.status))) throw new Error('invalid_delivery_response');
      if (boost?.correlated && (!request || typeof result.displayed !== 'boolean')) throw new Error('invalid_delivery_response');
      if (result.eligibleStoreIds !== undefined && !storeIds(result.eligibleStoreIds)) throw new Error('invalid_delivery_response');
      if (result.displayedStoreIds !== undefined && (!storeIds(result.displayedStoreIds) || !storeIds(result.eligibleStoreIds) || result.displayedStoreIds.some(id => !result.eligibleStoreIds.includes(id)))) throw new Error('invalid_delivery_response');
      if (boost?.sharedContract && (!storeIds(result.eligibleStoreIds) || !storeIds(result.displayedStoreIds))) throw new Error('invalid_delivery_response');
      if (boost?.storeId && request?.status === 'open' && Array.isArray(result.displayedStoreIds) && (!result.eligibleStoreIds.includes(boost.storeId) || result.displayed !== result.displayedStoreIds.includes(boost.storeId))) throw new Error('invalid_delivery_response');
      state.delivered[item.id] = now();
      state.lastDeliveryResult = { at: now(), displayed: typeof result?.displayed === 'boolean' ? result.displayed : null, requestStatus: ['open','closed','unknown'].includes(request?.status) ? request.status : 'legacy', eligibleStoreCount: result.eligibleStoreIds?.length ?? null, displayedStoreCount: result.displayedStoreIds?.length ?? null, messageHash: item.id };
      let status = result?.displayed === false ? 'stored_not_displayed' : 'delivered';
      if (boost && ['closed', 'unknown'].includes(request?.status)) {
        closeCurrent(boostId, boost); status = `request_${request.status}`;
      } else if (boost && result.displayedStoreIds === undefined && result?.displayed !== false && (box.requestOnly || rank.sent >= boost.requestedAt - 1000)) {
        delete state.boosts[boostId];
      }
      if (Array.isArray(result.displayedStoreIds)) {
        for (const [key, lookup] of Object.entries(state.boosts)) {
          if (lookup.username === parsed.username && lookup.until > now() && rank.sent >= lookup.acceptFrom && rank.sent < lookup.until && (!lookup.newest || compare(rank, lookup.newest) >= 0) && (result.displayedStoreIds.includes(lookup.storeId) || (!lookup.requestId && !lookup.storeId && result.displayed === true))) delete state.boosts[key];
        }
      }
      await save();
      return { status: 200, body: { status, markProcessed: true, messageId: item.email.id } };
    } catch (error) { return failure(input, error); }
  };
  const process = input => serial(() => processOne(input));
  return {
    due: id => serial(async () => {
      const box = mailbox(id); if (!box) return { status: 400, body: { error: 'unknown_mailbox' } };
      prune();
      const active = Object.values(state.boosts).filter(boost => boost.until > now());
      const normalDue = !box.requestOnly && (!state.polls[id] || now() - state.polls[id] >= 60_000);
      const fastDue = active.filter(boost => !boost.lastPoll || now() - boost.lastPoll >= 15_000);
      const selected = normalDue ? active : fastDue;
      const due = normalDue || fastDue.length > 0, mode = normalDue ? 'normal' : fastDue.length ? 'boosted' : 'idle';
      const sources = ['noreply@steampowered.com', ...(box.trustedForwarders || [])];
      const after = selected.length && !normalDue ? Math.min(...selected.map(boost => boost.acceptFrom)) : now() - TTL;
      let query = `after:${Math.floor(after / 1000) - 1} -in:trash {${sources.map(source => `from:${source}`).join(' ')}}`;
      if (mode === 'boosted') query += ` {${[...new Set(fastDue.map(boost => `"${boost.username}"`))].join(' ')}}`;
      if (due) {
        if (normalDue) state.polls[id] = now();
        for (const boost of selected) boost.lastPoll = now();
        await save();
      }
      return { status: 200, body: { due, boosted: active.length > 0, query: due ? query : '', mode, requestIds: due ? selected.map(scanId) : [] } };
    }),
    process,
    processBatch: async input => {
      if (!Array.isArray(input.messages) || input.messages.length > 250) return { status: 400, body: { error: 'invalid_batch' } };
      // Select before any delivery: list order and arrival order need not match Steam Date.
      const plan = await serial(async () => {
        prune(); const prepared = [], results = [];
        for (const message of input.messages) {
          const one = { ...input, message };
          if (fixtureBlocked(one)) { results.push({ status: 'mock_only_blocked', markProcessed: false }); continue; }
          try { prepared.push({ one, ...prepare(one) }); }
          catch (error) { results.push((await failure(one, error)).body); }
        }
        prepared.sort((a, b) => compare(b.rank, a.rank));
        const selected = [], accounts = new Set();
        for (const item of prepared) {
          if (accounts.has(item.parsed.username)) { results.push({ status: 'older_candidate', markProcessed: false }); continue; }
          accounts.add(item.parsed.username); selected.push(item.one);
        }
        return { selected, results };
      });
      // Release the serial queue between accounts so close/new lookup events can interleave.
      for (const one of plan.selected) plan.results.push((await process(one)).body);
      return { status: 200, body: { results: plan.results } };
    },
    webhook: (raw, signature) => serial(async () => {
      if (!verifySignature(raw, signature, webhookSecret)) return { status: 401, body: { error: 'invalid_signature' } };
      let event; try { event = JSON.parse(raw); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
      const at = Date.parse(event?.at);
      if (!validId(event?.id) || !Number.isFinite(at) || at > now() + 30_000 || now() - at >= TTL) return { status: 400, body: { error: 'invalid_or_stale_event' } };
      if (!['steam.otp.requested','steam.otp.request.closed'].includes(event.type)) return { status: 400, body: { error: 'unsupported_event' } };
      prune(); const eventId = digest(event.id);
      if (state.events[eventId]) return { status: 200, body: { accepted: true, duplicate: true } };
      if (event.type === 'steam.otp.request.closed') {
        if (!validId(event.requestId) || !['dismissed','superseded'].includes(event.reason) || !/^[a-zA-Z0-9_]{1,64}$/.test(event.accountUsername || '') || typeof event.storeId !== 'string' || !event.storeId) return { status: 400, body: { error: 'invalid_close_event' } };
        const boostId = digest(event.requestId), boost = state.boosts[boostId];
        if (boost) {
          if (boost.username !== lower(event.accountUsername) || (boost.storeId && boost.storeId !== event.storeId)) return { status: 400, body: { error: 'request_identity_mismatch' } };
          closeCurrent(boostId, boost);
        }
        // A close can arrive before its open event; remember it without calling Field Desk.
        state.closedRequests[digest(event.requestId)] = { until: at + TTL };
        state.events[eventId] = now(); await save();
        return { status: 202, body: { accepted: true } };
      }
      const requestId = event.requestId ?? event.id;
      if (!validId(requestId) || requestId !== event.id || (event.requestedAt !== undefined && Date.parse(event.requestedAt) !== at) || (event.acceptFrom !== undefined && Date.parse(event.acceptFrom) !== at - 60_000) || (event.watchUntil !== undefined && Date.parse(event.watchUntil) !== at + TTL)) return { status: 400, body: { error: 'invalid_request_window' } };
      if (![event.accountUsername,event.accountEmail].some(x => typeof x === 'string' && x.length && x.length < 255)) return { status: 400, body: { error: 'missing_account' } };
      if (state.closedRequests[digest(requestId)]) {
        state.events[eventId] = now(); await save(); return { status: 202, body: { accepted: true, closed: true } };
      }
      let username, storeId;
      if (event.eligibleStoreIds !== undefined) {
        if (!storeIds(event.eligibleStoreIds) || typeof event.storeId !== 'string' || !event.eligibleStoreIds.includes(event.storeId) || !/^[a-zA-Z0-9_]{1,64}$/.test(event.accountUsername || '') || (event.accountEmail !== undefined && typeof event.accountEmail !== 'string')) return { status: 400, body: { error: 'unmatched_or_ambiguous_account' } };
        username = lower(event.accountUsername); storeId = event.storeId;
      } else {
        let accounts;
        try { accounts = await (await fd('/steam/accounts')).json(); }
        catch { return { status: 503, body: { error: 'fielddesk_unavailable' } }; }
        if (!Array.isArray(accounts)) return { status: 503, body: { error: 'invalid_accounts_response' } };
        const matches = accounts.filter(account => (!event.accountUsername || lower(account.username) === lower(event.accountUsername)) && (!event.accountEmail || lower(account.email) === lower(event.accountEmail)));
        let eligible;
        try { eligible = matches.length === 1 ? eligibleStores(matches[0]) : []; }
        catch { return { status: 503, body: { error: 'invalid_accounts_response' } }; }
        storeId = event.storeId ?? (eligible.length === 1 ? eligible[0] : undefined);
        if (matches.length !== 1 || !eligible.includes(storeId) || !/^[a-zA-Z0-9_]{1,64}$/.test(matches[0].username)) return { status: 400, body: { error: 'unmatched_or_ambiguous_account' } };
        username = lower(matches[0].username);
      }
      const lookup = { username, storeId, requestId, requestedAt: at, acceptFrom: at - 60_000, until: at + TTL, lastPoll: 0, correlated: event.requestId !== undefined, sharedContract: event.eligibleStoreIds !== undefined };
      const boostId = lookupKey(lookup), slot = slotId(lookup);
      state.events[eventId] = now();
      if (state.latest[slot]?.at > at) {
        state.closedRequests[digest(requestId)] = { until: at + TTL }; await save();
        return { status: 202, body: { accepted: true, superseded: true } };
      }
      for (const [key, previous] of Object.entries(state.boosts)) if (slotId(previous) === slot) closeCurrent(key, previous);
      state.latest[slot] = { at, until: at + TTL };
      state.boosts[boostId] = lookup;
      await save();
      return { status: 202, body: { accepted: true } };
    }),
    issues: () => serial(async () => { prune(); return { status: 200, body: { issues: state.issues } }; }),
  };
}
