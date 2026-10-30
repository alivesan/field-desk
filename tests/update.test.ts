/*
 * The "new version" check: which module script a page loads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleScript } from '../src/lib/update.ts';

test('moduleScript: the built page’s module bundle, whatever the attribute order', () => {
  const built = '<head><link rel="stylesheet" crossorigin href="/assets/index-Qu79XZcc.css"></head><body><div id="root"></div><script type="module" crossorigin src="/assets/index-DvWQullW.js"></script></body>';
  assert.equal(moduleScript(built), '/assets/index-DvWQullW.js');
  assert.equal(moduleScript('<script src="/assets/index-A1.js" crossorigin type="module"></script>'), '/assets/index-A1.js');
  assert.equal(moduleScript("<script type='module' src='/assets/index-B2.js'></script>"), '/assets/index-B2.js');
  assert.notEqual(moduleScript(built), moduleScript(built.replace('DvWQullW', 'Zz9Yy8Xx')), 'a new build has a new name');
});

test('moduleScript: nothing to compare when the page has no module script', () => {
  assert.equal(moduleScript(''), null);
  assert.equal(moduleScript('<h1>Down for maintenance</h1>'), null);
  assert.equal(moduleScript('<script src="/analytics.js"></script><script type="module">boot()</script>'), null);
});
