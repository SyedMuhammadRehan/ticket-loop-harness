'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.DEPOT_ROOT;
const { seedStore } = require(path.join(ROOT, 'src', 'store.js'));
const { percentOf } = require(path.join(ROOT, 'src', 'money.js'));
const { taxFor } = require(path.join(ROOT, 'src', 'tax.js'));
const { createOrder } = require(path.join(ROOT, 'src', 'orders.js'));

test('the example in the ticket: 15% of 9.99 is 1.50', () => {
  assert.strictEqual(percentOf(999, 15), 150);
  const order = createOrder(seedStore(), { items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'US', code: 'SPRING15' });
  assert.strictEqual(order.discountCents, 150);
  assert.strictEqual(order.totalCents, 849);
});

test('a half cent rounds up, and anything under it rounds down', () => {
  assert.strictEqual(percentOf(10, 25), 3);
  assert.strictEqual(percentOf(1, 50), 1);
  assert.strictEqual(percentOf(333, 33), 110);
  assert.strictEqual(percentOf(149, 10), 15);
  assert.strictEqual(percentOf(144, 10), 14);
  assert.strictEqual(percentOf(0, 15), 0);
});

// The second site: tax is a percentage amount too.
test('tax rounds half up as well', () => {
  assert.strictEqual(taxFor(999, 'PK'), 170);
  assert.strictEqual(taxFor(10, 'AE'), 1);
  assert.strictEqual(taxFor(9, 'AE'), 0);
  assert.strictEqual(taxFor(12345, 'US'), 0);
});

test('an order with a discount and tax is right to the cent', () => {
  const order = createOrder(seedStore(), { items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'PK', code: 'SPRING15' });
  assert.strictEqual(order.discountCents, 150);
  assert.strictEqual(order.taxCents, 144);
  assert.strictEqual(order.totalCents, 993);
});

test('every amount is still a whole number of cents', () => {
  const order = createOrder(seedStore(), { items: [{ sku: 'BOLT-M6', qty: 7 }, { sku: 'WASH-M6', qty: 3 }], region: 'PK', code: 'TRADE10' });
  for (const key of ['subtotalCents', 'discountCents', 'taxCents', 'totalCents']) {
    assert.ok(Number.isInteger(order[key]), `${key} is ${order[key]}`);
  }
});

// docs/ARCHITECTURE.md rule 2: one place does percentages.
test('tax goes through the one place that rounds percentages', () => {
  const tax = fs.readFileSync(path.join(ROOT, 'src', 'tax.js'), 'utf8');
  assert.match(tax, /percentOf/, 'tax.js keeps its own copy of the arithmetic');
});
