'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seedStore } = require('../src/store.js');
const { applyDiscount } = require('../src/discounts.js');

test('a percent code takes its share of the subtotal', () => {
  const result = applyDiscount(seedStore(), 10000, 'SPRING15');
  assert.strictEqual(result.discountCents, 1500);
  assert.deepStrictEqual(result.applied, [{ code: 'SPRING15', amountCents: 1500 }]);
});

test('a fixed code takes its amount, never more than the subtotal', () => {
  const store = seedStore();
  assert.strictEqual(applyDiscount(store, 10000, 'WELCOME5').discountCents, 500);
  assert.strictEqual(applyDiscount(store, 300, 'WELCOME5').discountCents, 300);
});

test('codes are matched without regard to case, and an unknown one is refused', () => {
  const store = seedStore();
  assert.strictEqual(applyDiscount(store, 10000, 'welcome5').discountCents, 500);
  assert.throws(() => applyDiscount(store, 10000, 'FREE'), (err) => err.code === 'UNKNOWN_CODE');
});

test('no code means no discount', () => {
  assert.deepStrictEqual(applyDiscount(seedStore(), 10000, null), { discountCents: 0, applied: [] });
});
