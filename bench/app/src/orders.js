'use strict';
const { domainError } = require('./money.js');
const { findBySku } = require('./catalog.js');
const { reserve, release } = require('./inventory.js');
const { applyDiscount } = require('./discounts.js');
const { taxFor } = require('./tax.js');

function findOrder(store, id) {
  const order = store.orders.get(id);
  if (!order) throw domainError('NOT_FOUND', `no order ${id}`);
  return order;
}

function linesOf(store, items) {
  if (!Array.isArray(items) || items.length === 0) throw domainError('EMPTY_ORDER', 'an order needs at least one item');
  return items.map(({ sku, qty }) => {
    const product = findBySku(store, sku);
    return { sku, qty, unitCents: product.priceCents, lineCents: product.priceCents * qty };
  });
}

// Stock is reserved line by line; a line that cannot be filled gives back what the earlier
// lines took, so a refused order leaves the store as it found it.
function reserveAll(store, lines) {
  const taken = [];
  try {
    for (const line of lines) {
      reserve(store, line.sku, line.qty);
      taken.push(line);
    }
  } catch (err) {
    for (const line of taken) release(store, line.sku, line.qty);
    throw err;
  }
}

function createOrder(store, { items, region, code = null }) {
  const lines = linesOf(store, items);
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineCents, 0);
  const { discountCents, applied } = applyDiscount(store, subtotalCents, code);
  const taxCents = taxFor(subtotalCents - discountCents, region);
  reserveAll(store, lines);
  const order = {
    id: `ORD-${store.nextOrderNumber}`,
    status: 'placed',
    region,
    lines,
    subtotalCents,
    discountCents,
    discounts: applied,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
  store.nextOrderNumber += 1;
  store.orders.set(order.id, order);
  return order;
}

function shipOrder(store, id) {
  const order = findOrder(store, id);
  if (order.status !== 'placed') throw domainError('NOT_PLACED', `order ${id} is ${order.status}`);
  order.status = 'shipped';
  return order;
}

function cancelOrder(store, id) {
  const order = findOrder(store, id);
  for (const line of order.lines) release(store, line.sku, line.qty);
  order.status = 'cancelled';
  return order;
}

module.exports = { createOrder, shipOrder, cancelOrder, findOrder };
