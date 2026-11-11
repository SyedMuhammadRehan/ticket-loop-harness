'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seedStore } = require('../src/store.js');
const { findBySku, search } = require('../src/catalog.js');

test('a product is found by its sku, and a missing one is NOT_FOUND', () => {
  const store = seedStore();
  assert.strictEqual(findBySku(store, 'TAPE-5M').name, 'Tape measure 5 m');
  assert.throws(() => findBySku(store, 'NOPE'), (err) => err.code === 'NOT_FOUND');
});

test('search matches name or sku, ignoring case, and reports the total', () => {
  const store = seedStore();
  assert.strictEqual(search(store, 'bolt').total, 2);
  assert.strictEqual(search(store, 'M6').total, 3);
  assert.strictEqual(search(store, 'drill').total, 1);
  assert.strictEqual(search(store, '').total, 8);
  assert.strictEqual(search(store, 'unobtainium').total, 0);
});

test('search echoes the page it was asked for', () => {
  const result = search(seedStore(), '', { page: 2, pageSize: 3 });
  assert.strictEqual(result.page, 2);
  assert.strictEqual(result.pageSize, 3);
});
