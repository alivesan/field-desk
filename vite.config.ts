import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Dev never runs open: HQ needs a code here too. If none is set, one is generated once
 * and saved to .env.local (git-ignored) — open that file to see it.
 */
function devSuperCode(mode: string) {
  const env = process.env.SUPER_ADMIN_CODE?.trim();
  if (env) return { code: env, source: 'the SUPER_ADMIN_CODE environment variable' };
  const file = loadEnv(mode, process.cwd(), '').SUPER_ADMIN_CODE?.trim();
  if (file) return { code: file, source: 'the code in .env.local' };
  const code = randomBytes(12).toString('base64url');
  fs.appendFileSync('.env.local', `${fs.existsSync('.env.local') ? '\n' : ''}# HQ sign-in code for local dev — sign in at /hq\nSUPER_ADMIN_CODE=${code}\n`);
  return { code, source: 'the code in .env.local (just generated)' };
}

/** Mounts the Field Desk API inside the dev server, so `npm run dev` is the whole stack. */
function api(mode: string): Plugin {
  return {
    name: 'field-desk-api',
    async configureServer(server) {
      const { createApi } = await import('./server/api.ts');
      const { code, source } = devSuperCode(mode);
      const handler = createApi({ dataDir: process.env.DATA_DIR ?? '.data', superCode: code });
      // Vite restarts re-run this hook in the same process: release the DB handle, timers and data-dir lock.
      server.httpServer?.once('close', () => handler.close());
      server.config.logger.info(`  Field Desk: HQ signs in at /hq with ${source}`);
      server.middlewares.use((req, res, next) => {
        handler.handle(req, res).then((handled) => handled || next(), next);
      });
    },
  };
}

// `npm run dev:phone` serves over HTTPS on the LAN — phones only allow
// camera + geolocation on secure origins.
export default defineConfig(({ mode }) => ({
  plugins: [react(), api(mode), ...(mode === 'phone' ? [basicSsl()] : [])],
  server: { watch: { ignored: ['**/.data/**', '**/data/**', '**/.env.local'] } },
}));
