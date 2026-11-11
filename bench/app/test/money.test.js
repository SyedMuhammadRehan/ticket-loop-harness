'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toCents, format, percentOf } = require('../src/money.js');

test('text amounts become whole cents', () => {
  assert.strictEqual(toCents('12.34'), 1234);
  assert.strictEqual(toCents('7'), 700);
  assert.strictEqual(toCents('0.5'), 50);
});

test('anything that is not an amount is refused', () => {
  for (const bad of ['', 'abc', '1.234', '-5', '1,50']) {
    assert.throws(() => toCents(bad), (err) => err.code === 'BAD_AMOUNT', bad);
  }
});

test('cents are formatted with two decimals', () => {
  assert.strictEqual(format(1234), '12.34');
  assert.strictEqual(format(5), '0.05');
  assert.strictEqual(format(-250), '-2.50');
});

test('a whole percentage of a round amount is exact', () => {
  assert.strictEqual(percentOf(1000, 15), 150);
  assert.strictEqual(percentOf(20000, 5), 1000);
  assert.strictEqual(percentOf(0, 17), 0);
});
