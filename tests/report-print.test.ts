/*
 * The recce report's print layout. The markup is a React component (no JSX in node's test runner), so these check the source:
 * the address sits once in the header, and the print rules can't be undone by a phone's narrow viewport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const tsx = fs.readFileSync(new URL('../src/components/Report.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/styles/report.css', import.meta.url), 'utf8');

test('report: the address is in the header next to the venue pin, not a row of the Venue section', () => {
  assert.equal(tsx.match(/store\.address/g)?.length, 1);
  assert.ok(!/\['Address'/.test(tsx));
  const where = tsx.slice(tsx.indexOf('className="rp-where"'));
  assert.ok(where.indexOf('rp-addr') < where.indexOf('rp-pin'), 'address first, pin at the other end');
  assert.ok(tsx.indexOf('rp-where') < tsx.indexOf('rp-meta'), 'right below the store name, above the meta line');
  assert.ok(!/\['Venue pin'/.test(tsx));
});

test('report: Venue and Setup share one two-column row', () => {
  const pair = tsx.slice(tsx.indexOf('className="rp-pair"'));
  assert.ok(pair.indexOf("title: 'Venue'") > 0 && pair.indexOf("title: 'Venue'") < pair.indexOf("title: 'Setup'") && pair.indexOf("title: 'Setup'") < pair.indexOf("title: 'Laptops'"));
});

test('report css: breakpoints are screen-only, and print is A4 with a fixed two-column pair', () => {
  for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) {
    const q = m[1].trim();
    if (/width/.test(q)) assert.ok(/^screen\b/.test(q), `"${q}" would also apply when a phone prints`);
  }
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /@page\s*\{[^}]*size:\s*A4/);
  assert.match(print, /\.rp-pair\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.match(print, /\.rp-sec header\s*\{[^}]*break-after:\s*avoid/);
});
