// Synthetic local demonstration only. No mailboxes, n8n, or external APIs involved.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../mock/server.mjs';
import { createService } from '../worker/service.mjs';
const parent = new URL('../test-output/', import.meta.url);
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(new URL('demo-', parent));
const apiKey = randomBytes(32).toString('hex');
const server = createServer({ apiKey });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8790, '127.0.0.1', resolve); });
const worker = await createService({ statePath: join(directory, 'state.json'), mailboxes: [{ id: 'demo', provider: 'gmail' }], baseUrl: 'http://127.0.0.1:8790/api/v1', apiKey, webhookSecret: randomBytes(32).toString('hex') });
const result = await worker.process({ mailbox: 'demo', provider: 'gmail', message: { id: 'synthetic-demo', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'noreply@steampowered.com' }, { name: 'To', value: 'login-alpha@example.invalid' }, { name: 'Subject', value: 'Steam Guard code - synthetic demonstration' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=steampowered.com' }], body: { data: Buffer.from('Dear store_alpha,\nSteam Guard code is: A1B2C\n').toString('base64url') } } } });
if (!result.body.markProcessed) { server.close(); throw new Error('Synthetic delivery failed'); }
console.log('Synthetic email delivered to the local mock store card. Open http://127.0.0.1:8790/mock/store (expires in 10 minutes). Ctrl+C stops the demo.');
