'use strict';
const { domainError } = require('./money.js');
const { findBySku } = require('./catalog.js');

function requireQuantity(qty) {
  if (!Number.isInteger(qty) || qty <= 0) throw domainError('BAD_QUANTITY', 'a quantity is a whole number above zero');
}

function reserve(store, sku, qty) {
  requireQuantity(qty);
  const product = findBySku(store, sku);
  if (product.stock < qty) throw domainError('OUT_OF_STOCK', `only ${product.stock} of ${sku} left`);
  product.stock -= qty;
  return product.stock;
}

function release(store, sku, qty) {
  requireQuantity(qty);
  const product = findBySku(store, sku);
  product.stock += qty;
  return product.stock;
}

module.exports = { reserve, release };
