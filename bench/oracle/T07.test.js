'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = process.env.DEPOT_ROOT;
const { seedStore } = require(path.join(ROOT, 'src', 'store.js'));
const { createOrder, shipOrder, cancelOrder, findOrder } = require(path.join(ROOT, 'src', 'orders.js'));
const { createApp } = require(path.join(ROOT, 'src', 'http', 'app.js'));
const { issue } = require(path.join(ROOT, 'src', 'auth', 'tokens.js'));

const place = (store) => createOrder(store, { items: [{ sku: 'SAW-CIRC', qty: 2 }], region: 'US' }).id;
const stock = (store) => store.products.get('SAW-CIRC').stock;

test('cancelling a placed order returns its stock once', () => {
  const store = seedStore();
  const id = place(store);
  assert.strictEqual(stock(store), 0);
  assert.strictEqual(cancelOrder(store, id).status, 'cancelled');
  assert.strictEqual(stock(store), 2);
});

test('cancelling again is ALREADY_CANCELLED and stock does not move', () => {
  const store = seedStore();
  const id = place(store);
  cancelOrder(store, id);
  assert.throws(() => cancelOrder(store, id), (err) => err.code === 'ALREADY_CANCELLED');
  assert.throws(() => cancelOrder(store, id), (err) => err.code === 'ALREADY_CANCELLED');
  assert.strictEqual(stock(store), 2);
  assert.strictEqual(findOrder(store, id).status, 'cancelled');
});

// The half of the bug the ticket's example does not show.
test('a shipped order cannot be cancelled, and keeps its stock out', () => {
  const store = seedStore();
  const id = place(store);
  shipOrder(store, id);
  assert.throws(() => cancelOrder(store, id), (err) => err.code === 'ALREADY_SHIPPED');
  assert.strictEqual(stock(store), 0);
  assert.strictEqual(findOrder(store, id).status, 'shipped');
});

test('a cancelled order cannot be shipped', () => {
  const store = seedStore();
  const id = place(store);
  cancelOrder(store, id);
  assert.throws(() => shipOrder(store, id), (err) => err.code === 'NOT_PLACED');
});

test('an order that does not exist is still NOT_FOUND', () => {
  assert.throws(() => cancelOrder(seedStore(), 'ORD-0'), (err) => err.code === 'NOT_FOUND');
});

test('both refusals are a 409 over HTTP', () => {
  const NOW = 1_700_000_000_000;
  const store = seedStore();
  const handle = createApp(store, { secret: 's', now: () => NOW });
  const headers = { authorization: `Bearer ${issue('s', 'u1', NOW)}` };
  const cancel = (id) => handle({ method: 'POST', url: `/orders/${id}/cancel`, headers }).status;
  const first = place(store);
  assert.strictEqual(cancel(first), 200);
  assert.strictEqual(cancel(first), 409);
  const second = createOrder(store, { items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'US' }).id;
  shipOrder(store, second);
  assert.strictEqual(cancel(second), 409);
});
