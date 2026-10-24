import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createService } from './service.mjs';

const required = ['WORKER_TOKEN','FD_API_KEY','FD_WEBHOOK_SECRET','FIELD_DESK_BASE_URL'];
if (required.some(name => !process.env[name])) { console.error('Missing required worker configuration; see README.'); process.exit(1); }
const baseUrl = process.env.FIELD_DESK_BASE_URL.replace(/\/$/, '');
const target = new URL(baseUrl);
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['mock','127.0.0.1','localhost'].includes(target.hostname))) throw new Error('HTTPS required for non-local Field Desk');
let mailboxes;
try { mailboxes = JSON.parse(process.env.MAILBOXES || '[]'); } catch { throw new Error('Invalid MAILBOXES JSON'); }
if (!Array.isArray(mailboxes) || new Set(mailboxes.map(m => m.id)).size !== mailboxes.length || mailboxes.some(m => !/^[a-zA-Z0-9_-]{1,64}$/.test(m.id) || !['gmail','outlook'].includes(m.provider))) throw new Error('Invalid MAILBOXES entries');
const service = await createService({ statePath: process.env.STATE_PATH || './data/state.json', mailboxes, baseUrl, apiKey: process.env.FD_API_KEY, webhookSecret: process.env.FD_WEBHOOK_SECRET });
const authorized = req => {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${process.env.WORKER_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const server = createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true });
    if (!authorized(req)) return reply(401, { error: 'unauthorized' });
    let result;
    if (req.method === 'GET' && url.pathname === '/due') result = await service.due(url.searchParams.get('mailbox'));
    else if (req.method === 'GET' && url.pathname === '/issues') result = await service.issues();
    else if (req.method === 'POST' && ['/process','/webhook'].includes(url.pathname)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) { reply(413, { error: 'body_too_large' }); req.destroy(); return; } chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      if (url.pathname === '/webhook') result = await service.webhook(raw, req.headers['x-fielddesk-signature']);
      else { let input; try { input = JSON.parse(raw); } catch { return reply(400, { error: 'invalid_json' }); } result = await service.process(input); }
    } else return reply(404, { error: 'not_found' });
    reply(result.status, result.body);
  } catch { reply(500, { error: 'internal_error' }); }
});
server.requestTimeout = 15_000;
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log('OTP worker ready; payload logging disabled.'));
