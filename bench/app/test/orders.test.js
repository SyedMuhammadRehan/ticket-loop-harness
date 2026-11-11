'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seedStore } = require('../src/store.js');
const { createOrder, shipOrder, cancelOrder, findOrder } = require('../src/orders.js');
const { taxFor } = require('../src/tax.js');

test('an order totals its lines, takes the discount, then adds tax', () => {
  const store = seedStore();
  const order = createOrder(store, { items: [{ sku: 'DRILL-18V', qty: 1 }, { sku: 'BOLT-M6', qty: 20 }], region: 'AE', code: 'WELCOME5' });
  assert.strictEqual(order.subtotalCents, 12999 + 700);
  assert.strictEqual(order.discountCents, 500);
  assert.strictEqual(order.taxCents, taxFor(13199, 'AE'));
  assert.strictEqual(order.totalCents, 13199 + order.taxCents);
  assert.strictEqual(order.status, 'placed');
  assert.match(order.id, /^ORD-\d+$/);
});

test('placing an order takes its stock', () => {
  const store = seedStore();
  createOrder(store, { items: [{ sku: 'TAPE-5M', qty: 4 }], region: 'US' });
  assert.strictEqual(store.products.get('TAPE-5M').stock, 36);
});

test('an order that cannot be filled takes no stock at all', () => {
  const store = seedStore();
  assert.throws(
    () => createOrder(store, { items: [{ sku: 'TAPE-5M', qty: 4 }, { sku: 'NUT-M8', qty: 1 }], region: 'US' }),
    (err) => err.code === 'OUT_OF_STOCK'
  );
  assert.strictEqual(store.products.get('TAPE-5M').stock, 40);
  assert.strictEqual(store.orders.size, 0);
});

test('an empty order and an unknown region are refused', () => {
  const store = seedStore();
  assert.throws(() => createOrder(store, { items: [], region: 'US' }), (err) => err.code === 'EMPTY_ORDER');
  assert.throws(() => createOrder(store, { items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'ZZ' }), (err) => err.code === 'UNKNOWN_REGION');
  assert.strictEqual(store.products.get('TAPE-5M').stock, 40, 'a refused order reserves nothing');
});

test('a placed order can be shipped, once', () => {
  const store = seedStore();
  const { id } = createOrder(store, { items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'US' });
  assert.strictEqual(shipOrder(store, id).status, 'shipped');
  assert.throws(() => shipOrder(store, id), (err) => err.code === 'NOT_PLACED');
});

test('cancelling a placed order gives its stock back', () => {
  const store = seedStore();
  const { id } = createOrder(store, { items: [{ sku: 'SAW-CIRC', qty: 2 }], region: 'US' });
  assert.strictEqual(store.products.get('SAW-CIRC').stock, 0);
  assert.strictEqual(cancelOrder(store, id).status, 'cancelled');
  assert.strictEqual(store.products.get('SAW-CIRC').stock, 2);
  assert.strictEqual(findOrder(store, id).status, 'cancelled');
});

test('an order that does not exist is NOT_FOUND', () => {
  assert.throws(() => cancelOrder(seedStore(), 'ORD-1'), (err) => err.code === 'NOT_FOUND');
});
