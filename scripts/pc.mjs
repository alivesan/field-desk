// Run the real app from this PC: the built app + API on one port, using your real data (.data/)
// and your HQ code from .env.local — the same data and code as `npm run dev`.
//
//   npm run pc               build, then serve on http://localhost:8080 (and this PC's Wi-Fi address)
//   npm run pc -- --tunnel   the same, for use behind a tunnel (cloudflared) — trusts its forwarded address
//
// Stop `npm run dev` first: one server per data directory (it holds .data/.lock).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const envFile = path.resolve('.env.local');
const code = fs.existsSync(envFile) ? /^SUPER_ADMIN_CODE=(.+)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1]?.trim() : undefined;
if (!process.env.SUPER_ADMIN_CODE && !code) {
  console.error('No HQ code: run `npm run dev` once (it creates .env.local), or set SUPER_ADMIN_CODE.');
  process.exit(1);
}
process.env.SUPER_ADMIN_CODE ??= code;
process.env.DATA_DIR ??= '.data';
process.env.PORT ??= '8080';
if (process.argv.includes('--tunnel')) process.env.TRUST_PROXY ??= '1';

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `http://${a.address}:${process.env.PORT}`);
console.log(`Field Desk on http://localhost:${process.env.PORT} · data ${path.resolve(process.env.DATA_DIR)} · HQ signs in at /hq with the code in .env.local`);
if (lan.length) console.log(`Same Wi-Fi: ${lan.join(' · ')} (plain http — phones block GPS there; use the tunnel or npm run dev:phone for recce)`);

await import('../server/index.ts');
