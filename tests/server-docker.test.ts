import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * F07 without Docker: computes the build context `docker build .` would send (by applying
 * .dockerignore the way Docker does for these simple patterns) and checks the Dockerfile only
 * copies what's needed. Reads file names only — never file contents outside the source tree.
 * Set PRINT_DOCKER_CONTEXT=1 to print the list.
 */

const root = path.resolve(import.meta.dirname, '..');

function patterns() {
  return fs
    .readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((p) => {
      const neg = p.startsWith('!');
      const body = (neg ? p.slice(1) : p).replace(/^\/+/, '').replace(/\/+$/, '');
      const re = body
        .split('/')
        .map((seg) => (seg === '**' ? '(?:.*)' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')))
        .join('/')
        .replace(/\(\?:\.\*\)\//g, '(?:.*/)?');
      return { neg, re: new RegExp(`^${re}$`) };
    });
}

/** Docker semantics: a path is excluded if it, or any parent directory, matches; the last matching pattern wins. */
function excluded(rel: string, pats: ReturnType<typeof patterns>) {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    let ex = false;
    for (const p of pats) if (p.re.test(prefix)) ex = !p.neg;
    if (ex) return true;
  }
  return false;
}

function context() {
  const pats = patterns();
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (excluded(rel, pats)) continue;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/** Relative value imports (not `import type`) reachable from these files. */
function closure(entries: string[]) {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));
  }
  return [...seen].sort();
}

test('F07: the Docker build context holds no env files, secrets, data or VCS/tool state', () => {
  const files = context();
  if (process.env.PRINT_DOCKER_CONTEXT) console.log(files.join('\n'));
  const forbidden = files.filter((f) => /(^|\/)\.env/.test(f) || /\.local$/.test(f) || /^(\.git|\.data|data|dist|node_modules|\.claude|tests)(\/|$)/.test(f) || /\.db(-|$)/.test(f) || /\.md$/.test(f));
  assert.deepEqual(forbidden, []);
  // the things the build needs are there
  for (const need of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'server/index.ts', 'src/main.tsx', 'public/robots.txt']) assert.ok(files.includes(need), `${need} missing from context`);
  // the matcher itself, on names that exist in this workspace
  const pats = patterns();
  for (const f of ['.env.local', '.env', 'src/.env.production', 'x.local', '.data/field-desk.db', 'dist/index.html', 'node_modules/a/b.js', '.claude/settings.json', 'tests/smoke.test.ts', 'FIELD_DESK_AUDIT_2026-10-22.md']) {
    assert.ok(excluded(f, pats), `${f} should be excluded`);
  }
});

test('F07: the Dockerfile copies explicit paths only, and the runtime stage has exactly the modules the server imports', () => {
  const df = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const copies = [...df.matchAll(/^COPY\s+(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(!copies.some((c) => /^(\.|\.\/)\s/.test(c)), 'no COPY . .');
  const stages = df.split(/^FROM /m).slice(1);
  assert.equal(stages.length, 2, 'multi-stage');
  const runtime = stages[1];
  assert.match(runtime, /USER node/);

  const server = fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.ts')).map((f) => `server/${f}`);
  const needed = closure(server).filter((f) => f.startsWith('src/'));
  const copied = [...runtime.matchAll(/\/app\/(src\/lib\/[\w.-]+\.ts)/g)].map((m) => m[1]).sort();
  assert.deepEqual(copied, needed, 'update the runtime COPY of src/lib in the Dockerfile');
  // no browser-only module sneaks into the server's import graph
  assert.ok(!needed.some((f) => /db\.ts$|backup\.ts$/.test(f)), needed.join(', '));
});
