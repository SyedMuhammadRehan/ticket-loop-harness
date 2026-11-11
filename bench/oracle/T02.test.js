'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = process.env.DEPOT_ROOT;
const { seedStore } = require(path.join(ROOT, 'src', 'store.js'));
const inventory = require(path.join(ROOT, 'src', 'inventory.js'));
const { createApp } = require(path.join(ROOT, 'src', 'http', 'app.js'));
const { issue } = require(path.join(ROOT, 'src', 'auth', 'tokens.js'));

const SECRET = 'oracle-secret';
const NOW = 1_700_000_000_000;
const session = { authorization: `Bearer ${issue(SECRET, 'u1', NOW)}` };
const app = () => createApp(seedStore(), { secret: SECRET, now: () => NOW });

test('lowStock lists products at or below the threshold, lowest stock first, then by sku', () => {
  assert.deepStrictEqual(inventory.lowStock(seedStore(), 5), [
    { sku: 'NUT-M8', name: 'Hex nut M8', stock: 0 },
    { sku: 'SAW-CIRC', name: 'Circular saw', stock: 2 },
    { sku: 'BOLT-M8', name: 'Hex bolt M8', stock: 3 },
    { sku: 'WASH-M6', name: 'Washer M6', stock: 5 },
  ]);
});

test('equal stock is ordered by sku', () => {
  const store = seedStore();
  store.products.get('WASH-M6').stock = 2;
  assert.deepStrictEqual(inventory.lowStock(store, 2).map((p) => p.sku), ['NUT-M8', 'SAW-CIRC', 'WASH-M6']);
});

test('the threshold defaults to 5 and zero is a valid threshold', () => {
  assert.strictEqual(inventory.lowStock(seedStore()).length, 4);
  assert.deepStrictEqual(inventory.lowStock(seedStore(), 0).map((p) => p.sku), ['NUT-M8']);
});

test('a threshold that is not a whole number of zero or more is BAD_THRESHOLD', () => {
  for (const bad of [-1, 1.5, '5', NaN]) {
    assert.throws(() => inventory.lowStock(seedStore(), bad), (err) => err.code === 'BAD_THRESHOLD', String(bad));
  }
});

test('the route returns the list to a signed-in user', () => {
  const res = app()({ method: 'GET', url: '/inventory/low?threshold=2', headers: session });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.items.map((p) => p.sku), ['NUT-M8', 'SAW-CIRC']);
  const byDefault = app()({ method: 'GET', url: '/inventory/low', headers: session });
  assert.strictEqual(byDefault.body.items.length, 4);
});

test('the route needs a session and refuses a bad threshold with a 400', () => {
  assert.strictEqual(app()({ method: 'GET', url: '/inventory/low' }).status, 401);
  for (const bad of ['-1', 'abc', '1.5']) {
    assert.strictEqual(app()({ method: 'GET', url: `/inventory/low?threshold=${bad}`, headers: session }).status, 400, bad);
  }
});

test('the report reserves and changes nothing', () => {
  const store = seedStore();
  const before = JSON.stringify([...store.products.values()]);
  inventory.lowStock(store, 5);
  assert.strictEqual(JSON.stringify([...store.products.values()]), before);
});
