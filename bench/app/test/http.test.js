'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seedStore } = require('../src/store.js');
const { createApp } = require('../src/http/app.js');
const { issue } = require('../src/auth/tokens.js');

const SECRET = 'test-secret';
const NOW = 1_700_000_000_000;

function app() {
  const store = seedStore();
  const handle = createApp(store, { secret: SECRET, now: () => NOW });
  const session = { authorization: `Bearer ${issue(SECRET, 'u1', NOW)}` };
  return { store, handle, session };
}

test('health answers without a session', () => {
  assert.deepStrictEqual(app().handle({ method: 'GET', url: '/health' }), { status: 200, body: { ok: true } });
});

test('products can be searched without a session', () => {
  const res = app().handle({ method: 'GET', url: '/products?term=saw' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 1);
});

test('a page that is not a whole number above zero is a 400', () => {
  for (const page of ['0', '-1', 'x', '1.5']) {
    assert.strictEqual(app().handle({ method: 'GET', url: `/products?page=${page}` }).status, 400, page);
  }
});

test('orders need a session', () => {
  const { handle } = app();
  const body = { items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'US' };
  assert.strictEqual(handle({ method: 'POST', url: '/orders', body }).status, 401);
  assert.strictEqual(handle({ method: 'POST', url: '/orders', body, headers: { authorization: 'Bearer forged.1.x' } }).status, 401);
});

test('an order is placed, read back and cancelled over HTTP', () => {
  const { handle, session, store } = app();
  const placed = handle({ method: 'POST', url: '/orders', headers: session, body: { items: [{ sku: 'TAPE-5M', qty: 2 }], region: 'US' } });
  assert.strictEqual(placed.status, 201);
  const id = placed.body.id;
  assert.strictEqual(handle({ method: 'GET', url: `/orders/${id}`, headers: session }).body.status, 'placed');
  assert.strictEqual(handle({ method: 'POST', url: `/orders/${id}/cancel`, headers: session }).body.status, 'cancelled');
  assert.strictEqual(store.products.get('TAPE-5M').stock, 40);
});

test('domain refusals map to their statuses by code', () => {
  const { handle, session } = app();
  const post = (body) => handle({ method: 'POST', url: '/orders', headers: session, body }).status;
  assert.strictEqual(post({ items: [{ sku: 'NUT-M8', qty: 1 }], region: 'US' }), 409);
  assert.strictEqual(post({ items: [{ sku: 'GHOST', qty: 1 }], region: 'US' }), 404);
  assert.strictEqual(post({ items: [], region: 'US' }), 400);
  assert.strictEqual(post({ items: [{ sku: 'TAPE-5M', qty: 1 }], region: 'ZZ' }), 422);
  assert.strictEqual(handle({ method: 'GET', url: '/nowhere' }).status, 404);
});
