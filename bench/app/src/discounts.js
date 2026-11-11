'use strict';
const { percentOf, domainError } = require('./money.js');

function findDiscount(store, code) {
  const discount = store.discounts.get(String(code).toUpperCase());
  if (!discount) throw domainError('UNKNOWN_CODE', `no discount code ${code}`);
  return discount;
}

// What one code takes off a subtotal, never more than the subtotal itself.
function discountAmount(subtotalCents, discount) {
  const raw = discount.kind === 'percent' ? percentOf(subtotalCents, discount.value) : discount.value;
  return Math.min(raw, subtotalCents);
}

function applyDiscount(store, subtotalCents, code) {
  if (!code) return { discountCents: 0, applied: [] };
  const discount = findDiscount(store, code);
  const amountCents = discountAmount(subtotalCents, discount);
  return { discountCents: amountCents, applied: [{ code: discount.code, amountCents }] };
}

module.exports = { applyDiscount, discountAmount, findDiscount };
