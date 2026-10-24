import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TTL = 600_000;
export const digest = value => createHash('sha256').update(value).digest('hex');
const addr = value => String(value || '').trim().toLowerCase();
const addresses = value => (String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(addr);
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
      subject: header('subject'), auth: header('authentication-results'), authCount: headers.filter(h => h.name?.toLowerCase() === 'authentication-results').length, receivedAt: new Date(Number(message.internalDate)).toISOString(),
      text: plain.length ? plain.map(p => p.value).join('\n') : parts.map(p => textFromHtml(p.value)).join('\n') };
  }
  if (provider === 'outlook') return { id: message.id, sender: [addr(message.from?.emailAddress?.address)],
    recipients: (message.toRecipients || []).map(r => addr(r.emailAddress?.address)), subject: message.subject || '',
    auth: (message.internetMessageHeaders || []).filter(h => h.name?.toLowerCase() === 'authentication-results').map(h => h.value).join('\n'),
    authCount: (message.internetMessageHeaders || []).filter(h => h.name?.toLowerCase() === 'authentication-results').length,
    receivedAt: message.receivedDateTime, text: message.body?.contentType?.toLowerCase() === 'html' ? textFromHtml(message.body.content) : message.body?.content || '' };
  throw new Error('invalid_provider');
}
export function parseEmail(email, now = Date.now()) {
  const received = Date.parse(email.receivedAt);
  if (!Number.isFinite(received) || received > now + 30_000 || now - received >= TTL) throw new Error('expired_or_invalid_time');
  if (email.sender.length !== 1 || email.sender[0] !== 'noreply@steampowered.com') throw new Error('sender_rejected');
  // Multiple results can contain attacker-supplied headers. Fail closed until the
  // receiving provider's real header layout has been verified with the owner.
  const dmarcResults = [...email.auth.matchAll(/\bdmarc=([^;\s]+)/gi)];
  if (email.authCount !== 1 || dmarcResults.length !== 1 || !/\bdmarc=pass\b[^;\r\n]*\bheader\.from=steampowered\.com(?=[;\s]|$)/i.test(email.auth)) throw new Error('sender_auth_unverified');
  const combined = `${email.subject}\n${email.text}`;
  if (!/steam\s+guard|new\s+(?:device|computer)|access\s+from\s+a\s+new|login\s+code|log.?in\s+attempt/i.test(combined)) throw new Error('not_guard_email');
  const found = new Set();
  for (const match of combined.matchAll(/(?:steam\s+guard|access|login|log.?in|security|verification)?\s*code\s*(?:is\s*:?|:)\s*([A-Z0-9]{5})\b/g)) found.add(match[1]);
  for (const line of email.text.split(/\r?\n/)) if (/^[A-Z0-9]{5}$/.test(line.trim())) found.add(line.trim());
  if (found.size !== 1) throw new Error('ambiguous_or_missing_code');
  const usernames = new Set();
  for (const match of combined.matchAll(/(?:Steam\s+account(?:\s+name)?\s*[:：]\s*|Dear\s+)([A-Za-z0-9_]+)(?:[,\s]|$)/gi)) usernames.add(match[1].toLowerCase());
  if (usernames.size > 1) throw new Error('ambiguous_account_name');
  return { code: [...found][0], username: [...usernames][0] || null, receivedAt: new Date(received).toISOString(), recipients: email.recipients };
}
export function matchAccount(parsed, accounts) {
  if (!Array.isArray(accounts)) throw new Error('invalid_accounts_response');
  const matches = parsed.username ? accounts.filter(a => addr(a.username) === parsed.username)
    : accounts.filter(a => parsed.recipients.includes(addr(a.email)));
  if (matches.length !== 1 || !matches[0].assignedStoreId) throw new Error('unmatched_or_ambiguous_account');
  return matches[0];
}
export function verifySignature(raw, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
