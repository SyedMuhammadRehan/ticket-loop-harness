'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seedStore } = require('../src/store.js');
const { reserve, release } = require('../src/inventory.js');

test('reserving takes stock and releasing gives it back', () => {
  const store = seedStore();
  assert.strictEqual(reserve(store, 'DRILL-18V', 2), 5);
  assert.strictEqual(release(store, 'DRILL-18V', 2), 7);
});

test('more than is in stock is OUT_OF_STOCK and takes nothing', () => {
  const store = seedStore();
  assert.throws(() => reserve(store, 'SAW-CIRC', 3), (err) => err.code === 'OUT_OF_STOCK');
  assert.strictEqual(store.products.get('SAW-CIRC').stock, 2);
});

test('a quantity must be a whole number above zero', () => {
  const store = seedStore();
  for (const qty of [0, -1, 1.5, '2']) {
    assert.throws(() => reserve(store, 'TAPE-5M', qty), (err) => err.code === 'BAD_QUANTITY', String(qty));
  }
});
