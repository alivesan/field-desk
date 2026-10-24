import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../deploy/.env', import.meta.url);
let template = await readFile(new URL('../deploy/.env.example', import.meta.url), 'utf8');
for (const name of ['N8N_ENCRYPTION_KEY','WORKER_TOKEN','FD_API_KEY','FD_WEBHOOK_SECRET']) {
  const value = (name === 'FD_API_KEY' ? 'fd_' : '') + randomBytes(32).toString('hex');
  template = template.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`);
}
template = template.replace(/^#?\s*FIELD_DESK_BASE_URL=.*$/m, 'FIELD_DESK_BASE_URL=http://mock:8790/api/v1');
await writeFile(file, template, { flag: 'wx', mode: 0o600 });
console.log('Created ignored local .env with random secrets. No secrets printed. Existing files are never overwritten.');
