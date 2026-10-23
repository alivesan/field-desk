// Isolated dev instance for testing: port 5174, throwaway data dir, synthetic HQ code.
// Never touches .data/ or .env.local.
//
//   node scripts/isolated-dev.mjs [--fresh]
//
// The synthetic HQ code is written to <data dir>/SYNTHETIC_HQ_CODE.txt (test-only credential).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'vite';

const dir = path.join(os.tmpdir(), 'field-desk-isolated');
if (process.argv.includes('--fresh')) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const codeFile = path.join(dir, 'SYNTHETIC_HQ_CODE.txt');
if (!fs.existsSync(codeFile)) fs.writeFileSync(codeFile, `iso-${crypto.randomBytes(9).toString('base64url')}\n`);

process.env.DATA_DIR = dir;
process.env.SUPER_ADMIN_CODE = fs.readFileSync(codeFile, 'utf8').trim();
process.env.COOKIE_NAME = 'fd_isolated_session'; // localhost cookies ignore ports — don't clobber the real dev session

// Own dependency cache: sharing node_modules/.vite with `npm run dev` makes the two servers
// keep invalidating each other's pre-bundled deps (504 "Outdated Request", blank page).
const server = await createServer({ configFile: path.resolve('vite.config.ts'), cacheDir: path.join(dir, 'vite-cache'), server: { port: 5174, strictPort: true } });
await server.listen();
console.log(`Field Desk (isolated) on http://localhost:5174 · data ${dir} · HQ code in ${codeFile}`);
