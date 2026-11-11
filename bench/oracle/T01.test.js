'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = process.env.DEPOT_ROOT;
const { seedStore } = require(path.join(ROOT, 'src', 'store.js'));
const { search } = require(path.join(ROOT, 'src', 'catalog.js'));
const { createApp } = require(path.join(ROOT, 'src', 'http', 'app.js'));

const ALL = ['BOLT-M6', 'BOLT-M8', 'DRILL-18V', 'NUT-M6', 'NUT-M8', 'SAW-CIRC', 'TAPE-5M', 'WASH-M6'];
const skus = (result) => result.items.map((p) => p.sku);

test('page 1 returns the first matches in sku order', () => {
  assert.deepStrictEqual(skus(search(seedStore(), '', { page: 1, pageSize: 3 })), ALL.slice(0, 3));
});

test('pages continue with no gap and no repeat, and together are every match', () => {
  const store = seedStore();
  const seen = [1, 2, 3].flatMap((page) => skus(search(store, '', { page, pageSize: 3 })));
  assert.deepStrictEqual(seen, ALL);
});

test('a page past the end is empty and total still counts the matches', () => {
  const result = search(seedStore(), '', { page: 9, pageSize: 3 });
  assert.deepStrictEqual(result.items, []);
  assert.strictEqual(result.total, 8);
});

test('the default page is the first one', () => {
  assert.deepStrictEqual(skus(search(seedStore(), 'bolt')), ['BOLT-M6', 'BOLT-M8']);
});

test('the fix reaches the HTTP route', () => {
  const handle = createApp(seedStore(), { secret: 's', now: () => 0 });
  const res = handle({ method: 'GET', url: '/products?page=1&pageSize=2' });
  assert.deepStrictEqual(res.body.items.map((p) => p.sku), ALL.slice(0, 2));
});
