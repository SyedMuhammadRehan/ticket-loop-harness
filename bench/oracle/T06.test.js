'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = process.env.DEPOT_ROOT;
const { seedStore } = require(path.join(ROOT, 'src', 'store.js'));
const { createOrder } = require(path.join(ROOT, 'src', 'orders.js'));
const { createApp } = require(path.join(ROOT, 'src', 'http', 'app.js'));
const { issue } = require(path.join(ROOT, 'src', 'auth', 'tokens.js'));

// 100.00 of bolts and nuts: 200 x 0.35 + 250 x 0.12.
const CART = [{ sku: 'BOLT-M6', qty: 200 }, { sku: 'NUT-M6', qty: 250 }];
const order = (extra) => createOrder(seedStore(), { items: CART, region: 'US', ...extra });

test('one percentage code and one fixed code combine, percentage first', () => {
  const o = order({ codes: ['WELCOME5', 'TRADE10'] });
  assert.strictEqual(o.subtotalCents, 10000);
  assert.deepStrictEqual(o.discounts, [
    { code: 'TRADE10', amountCents: 1000 },
    { code: 'WELCOME5', amountCents: 500 },
  ]);
  assert.strictEqual(o.discountCents, 1500);
  assert.strictEqual(o.totalCents, 8500);
});

test('fixed codes apply in the order given', () => {
  const o = order({ codes: ['LOYAL2', 'WELCOME5'] });
  assert.deepStrictEqual(o.discounts.map((d) => d.code), ['LOYAL2', 'WELCOME5']);
  assert.strictEqual(o.discountCents, 700);
});

test('a second percentage code is ONE_PERCENT_CODE', () => {
  assert.throws(() => order({ codes: ['TRADE10', 'SPRING15'] }), (err) => err.code === 'ONE_PERCENT_CODE');
});

test('the same code twice is DUPLICATE_CODE, in any case', () => {
  assert.throws(() => order({ codes: ['WELCOME5', 'welcome5'] }), (err) => err.code === 'DUPLICATE_CODE');
});

test('an unknown code among good ones is still UNKNOWN_CODE', () => {
  assert.throws(() => order({ codes: ['WELCOME5', 'FREE100'] }), (err) => err.code === 'UNKNOWN_CODE');
});

test('the total discount never exceeds the subtotal: a fixed code takes only what is left', () => {
  const store = seedStore();
  const o = createOrder(store, { items: [{ sku: 'BOLT-M6', qty: 16 }], region: 'US', codes: ['WELCOME5', 'LOYAL2'] });
  assert.strictEqual(o.subtotalCents, 560);
  assert.deepStrictEqual(o.discounts, [
    { code: 'WELCOME5', amountCents: 500 },
    { code: 'LOYAL2', amountCents: 60 },
  ]);
  assert.strictEqual(o.totalCents, 0);
});

test('tax is charged on the subtotal less the whole discount', () => {
  const o = createOrder(seedStore(), { items: CART, region: 'AE', codes: ['TRADE10', 'WELCOME5'] });
  assert.strictEqual(o.taxCents, 425);
  assert.strictEqual(o.totalCents, 8925);
});

test('the single code still works and means a list of one', () => {
  const single = order({ code: 'TRADE10' });
  const listed = order({ codes: ['TRADE10'] });
  assert.strictEqual(single.discountCents, 1000);
  assert.deepStrictEqual(single.discounts, listed.discounts);
  assert.strictEqual(order({}).discountCents, 0);
  assert.strictEqual(order({ codes: [] }).discountCents, 0);
});

test('a refused order reserves no stock', () => {
  const store = seedStore();
  assert.throws(() => createOrder(store, { items: CART, region: 'US', codes: ['TRADE10', 'SPRING15'] }));
  assert.strictEqual(store.products.get('BOLT-M6').stock, 400);
  assert.strictEqual(store.products.get('NUT-M6').stock, 900);
  assert.strictEqual(store.orders.size, 0);
});

test('the new refusals reach HTTP as 422', () => {
  const NOW = 1_700_000_000_000;
  const handle = createApp(seedStore(), { secret: 's', now: () => NOW });
  const headers = { authorization: `Bearer ${issue('s', 'u1', NOW)}` };
  const post = (codes) => handle({ method: 'POST', url: '/orders', headers, body: { items: CART, region: 'US', codes } });
  assert.strictEqual(post(['TRADE10', 'SPRING15']).status, 422);
  assert.strictEqual(post(['WELCOME5', 'WELCOME5']).status, 422);
  assert.strictEqual(post(['TRADE10', 'WELCOME5']).status, 201);
});
