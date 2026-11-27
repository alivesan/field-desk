import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TTL = 600_000;
export const digest = value => createHash('sha256').update(value).digest('hex');
const addr = value => String(value || '').trim().toLowerCase();
const addresses = value => [...new Set((String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(addr))];
export function textFromHtml(html) {
  return String(html || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/tr|\/td|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function gmailParts(part) {
  if (!part) return [];
  const own = ['text/plain', 'text/html'].includes(part.mimeType) && part.body?.data
    ? [{ type: part.mimeType, value: Buffer.from(part.body.data, 'base64url').toString('utf8') }] : [];
  return [...own, ...(part.parts || []).flatMap(gmailParts)];
}
export function normalize(provider, message) {
  if (!message || typeof message.id !== 'string' || !message.id) throw new Error('invalid_message');
  if (provider === 'gmail') {
    const headers = message.payload?.headers || [];
    const header = name => headers.filter(h => h.name?.toLowerCase() === name).map(h => h.value).join('\n');
    const parts = gmailParts(message.payload);
    const plain = parts.filter(p => p.type === 'text/plain');
    return { id: message.id, sender: addresses(header('from')), recipients: addresses(header('to')),
      subject: header('subject'), originalDate: header('date'), auth: header('authentication-results'), authCount: headers.filter(h => h.name?.toLowerCase() === 'authentication-results').length, receivedAt: new Date(Number(message.internalDate)).toISOString(),
      text: plain.length ? plain.map(p => p.value).join('\n') : parts.map(p => textFromHtml(p.value)).join('\n') };
  }
  if (provider === 'outlook') return { id: message.id, sender: [addr(message.from?.emailAddress?.address)],
    recipients: (message.toRecipients || []).map(r => addr(r.emailAddress?.address)), subject: message.subject || '',
    auth: (message.internetMessageHeaders || []).filter(h => h.name?.toLowerCase() === 'authentication-results').map(h => h.value).join('\n'),
    authCount: (message.internetMessageHeaders || []).filter(h => h.name?.toLowerCase() === 'authentication-results').length,
    receivedAt: message.receivedDateTime, text: message.body?.contentType?.toLowerCase() === 'html' ? textFromHtml(message.body.content) : message.body?.content || '' };
  throw new Error('invalid_provider');
}
export function parseEmail(email, now = Date.now(), { trustedForwarders = [], allowRequestedRedirects = false, requestedUsernames = [] } = {}) {
  const arrival = Date.parse(email.receivedAt);
  if (!Number.isFinite(arrival) || arrival > now + 30_000 || now - arrival >= TTL) throw new Error('expired_or_invalid_time');
  const direct = email.sender.length === 1 && email.sender[0] === 'noreply@steampowered.com';
  const forwarded = email.sender.length === 1 && trustedForwarders.map(addr).includes(email.sender[0]);
  if (!direct && !forwarded) throw new Error('sender_rejected');
  // Owner-selected redirects can lose original authentication. This opt-in route
  // requires an exact confirmed recipient and a live request for the body username.
  const requestedRedirect = allowRequestedRedirects === true && direct && email.recipients.length === 1
    && trustedForwarders.map(addr).includes(email.recipients[0]);
  const dmarcResults = [...email.auth.matchAll(/\bdmarc=([^;\s]+)/gi)];
  const authDomain = email.auth.match(/\bdmarc=pass\b[^;\r\n]*\bheader\.from=([^;\s]+)/i)?.[1]?.toLowerCase();
  const authenticated = email.authCount === 1 && dmarcResults.length === 1 && /^\s*mx\.google\.com\s*;/i.test(email.auth) && authDomain === email.sender[0].split('@')[1];
  if (!authenticated && !requestedRedirect) throw new Error('sender_auth_unverified');
  const parseOriginalDate = value => {
    // Reject timezone-less human forwarding dates instead of guessing server time.
    if (!/(?:[+-]\d{4}|\b(?:GMT|UTC))\s*(?:\([^)]*\))?$/i.test(value || '')) throw new Error('original_date_unverified');
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error('original_date_unverified');
    return time;
  };
  const times = [arrival, parseOriginalDate(email.originalDate)];
  const lines = email.text.split(/\r?\n/).map(line => forwarded ? line.replace(/^\s*(?:>\s*)+/, '').trim() : line);
  if (forwarded) {
    if (!lines.some(line => /^From\s*:/i.test(line) && addresses(line).length === 1 && addresses(line)[0] === 'noreply@steampowered.com')) throw new Error('forward_origin_unverified');
    const dates = lines.filter(line => /^(?:Date|Sent)\s*:/i.test(line)).map(line => line.replace(/^(?:Date|Sent)\s*:\s*/i, ''));
    if (dates.length !== 1) throw new Error('original_date_unverified');
    times.push(parseOriginalDate(dates[0]));
  }
  if (times.some(time => time > now + 30_000 || now - time >= TTL)) throw new Error('expired_or_invalid_time');
  const received = Math.min(...times);
  const combined = `${email.subject}\n${lines.join('\n')}`;
  if (!/steam\s+guard|new\s+(?:device|computer)|access\s+from\s+a\s+new|login\s+code|log.?in\s+attempt/i.test(combined)) throw new Error('not_guard_email');
  const found = new Set();
  for (const match of combined.matchAll(/(?:steam\s+guard|access|login|log.?in|security|verification)?\s*code\s*(?:is\s*:?|:)\s*([A-Z0-9]{5})\b/gi)) {
    if (/^[A-Z0-9]{5}$/.test(match[1])) found.add(match[1]);
  }
  for (const line of lines) if (/^[A-Z0-9]{5}$/.test(line.trim())) found.add(line.trim());
  if (found.size !== 1) throw new Error('ambiguous_or_missing_code');
  const usernames = new Set();
  const body = lines.join('\n');
  for (const match of body.matchAll(/(?:Steam\s+account(?:\s+name)?\s*[:：]\s*|Dear\s+)([A-Za-z0-9_]+)(?:[,\s]|$)/gi)) usernames.add(match[1].toLowerCase());
  // During a signed request the exact account name is already known. Steam's
  // layouts need not use a particular greeting, but the name must occur in body.
  for (const value of requestedUsernames) {
    const username = addr(value);
    if (/^[a-z0-9_]{1,64}$/.test(username) && new RegExp(`(?:^|[^a-z0-9_])${username}(?=$|[^a-z0-9_])`, 'i').test(body)) usernames.add(username);
  }
  if (usernames.size > 1) throw new Error('ambiguous_account_name');
  if (usernames.size !== 1) throw new Error('account_name_missing');
  if (!authenticated && !requestedUsernames.map(addr).includes([...usernames][0])) throw new Error('no_active_request');
  return { code: [...found][0], username: [...usernames][0] || null, receivedAt: new Date(received).toISOString(), recipients: email.recipients };
}
export function eligibleStores(account) {
  if (account.eligibleStoreIds !== undefined) {
    if (!Array.isArray(account.eligibleStoreIds) || account.eligibleStoreIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('invalid_accounts_response');
    return [...new Set(account.eligibleStoreIds)];
  }
  // Pre-PR #23 directories have no holder list. Never use this fallback when an
  // explicit list is empty: the current eligibility list is authoritative.
  return typeof account.assignedStoreId === 'string' && account.assignedStoreId ? [account.assignedStoreId] : [];
}
export function matchAccount(parsed, accounts) {
  if (!Array.isArray(accounts)) throw new Error('invalid_accounts_response');
  if (!parsed.username) throw new Error('account_name_missing');
  const matches = accounts.filter(a => addr(a.username) === addr(parsed.username));
  if (matches.length !== 1 || eligibleStores(matches[0]).length === 0) throw new Error('unmatched_or_ambiguous_account');
  return matches[0];
}
export function verifySignature(raw, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
