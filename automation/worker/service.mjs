import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TTL, digest, normalize, parseEmail, matchAccount, verifySignature } from './core.mjs';

const safeReasons = new Set(['invalid_message','invalid_provider','expired_or_invalid_time','sender_rejected','sender_auth_unverified','not_guard_email','ambiguous_or_missing_code','ambiguous_account_name','invalid_accounts_response','unmatched_or_ambiguous_account','fielddesk_unavailable']);
export async function createService({ statePath, mailboxes, baseUrl, apiKey, webhookSecret, fetchImpl = fetch, now = Date.now }) {
  let state = { delivered: {}, events: {}, boosts: {}, polls: {}, issues: [] };
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('state_unreadable'); }
  for (const key of ['delivered','events','boosts','polls']) if (!state[key] || typeof state[key] !== 'object') throw new Error('invalid_state');
  if (!Array.isArray(state.issues)) throw new Error('invalid_state');
  const save = async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
  };
  const prune = () => {
    for (const key of ['delivered','events']) for (const [id, time] of Object.entries(state[key])) if (now() - time > 86400_000) delete state[key][id];
    for (const [id, time] of Object.entries(state.boosts)) if (time <= now()) delete state.boosts[id];
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
  return {
    due: id => serial(async () => {
      const box = mailbox(id); if (!box) return { status: 400, body: { error: 'unknown_mailbox' } };
      prune();
      // Multiple accounts may share a mailbox. Boost all mailbox scans while any request is active.
      const boosted = Object.values(state.boosts).some(until => until > now());
      const interval = boosted ? 15_000 : 60_000;
      const due = !state.polls[id] || now() - state.polls[id] >= interval;
      if (due) { state.polls[id] = now(); await save(); }
      return { status: 200, body: { due, boosted } };
    }),
    process: input => serial(async () => {
      prune();
      const box = mailbox(input.mailbox);
      if (!box || input.provider !== box.provider) return { status: 400, body: { error: 'mailbox_provider_mismatch' } };
      let id;
      try {
        const email = normalize(input.provider, input.message); id = digest(`${box.id}\0${email.id}`);
        if (state.delivered[id]) return { status: 200, body: { status: 'already_delivered', markProcessed: true, messageId: email.id } };
        const parsed = parseEmail(email, now());
        const accounts = await (await fd('/steam/accounts')).json();
        const account = matchAccount(parsed, accounts);
        // Recheck age after network delay. Never persist the code or the provider payload.
        if (now() - Date.parse(parsed.receivedAt) >= TTL) throw new Error('expired_or_invalid_time');
        await fd('/steam/otp', { method: 'POST', headers: { 'Idempotency-Key': `steam-email-${id}` }, body: JSON.stringify({ accountUsername: account.username, code: parsed.code, receivedAt: parsed.receivedAt }) });
        state.delivered[id] = now(); await save();
        return { status: 200, body: { status: 'delivered', markProcessed: true, messageId: email.id } };
      } catch (error) {
        const reason = safeReasons.has(error.message) ? error.message : 'processing_failed';
        if (!state.issues.some(i => i.messageHash === id && i.reason === reason && i.mailbox === box.id)) state.issues.push({ mailbox: box.id, messageHash: id, reason, at: now() });
        await save();
        return { status: 200, body: { status: reason, markProcessed: false } };
      }
    }),
    webhook: (raw, signature) => serial(async () => {
      if (!verifySignature(raw, signature, webhookSecret)) return { status: 401, body: { error: 'invalid_signature' } };
      let event; try { event = JSON.parse(raw); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
      const at = Date.parse(event.at);
      if (typeof event.id !== 'string' || !event.id || event.id.length > 200 || !Number.isFinite(at) || at > now() + 30_000 || now() - at >= TTL) return { status: 400, body: { error: 'invalid_or_stale_event' } };
      if (event.type !== 'steam.otp.requested') return { status: 400, body: { error: 'unsupported_event' } };
      if (![event.accountUsername,event.accountEmail].some(x => typeof x === 'string' && x.length && x.length < 255)) return { status: 400, body: { error: 'missing_account' } };
      prune(); const eventId = digest(event.id);
      if (state.events[eventId]) return { status: 200, body: { accepted: true, duplicate: true } };
      state.events[eventId] = now();
      state.boosts[digest(event.accountUsername || event.accountEmail)] = at + TTL;
      state.polls = {}; await save();
      return { status: 202, body: { accepted: true } };
    }),
    issues: () => serial(async () => { prune(); return { status: 200, body: { issues: state.issues } }; }),
  };
}
