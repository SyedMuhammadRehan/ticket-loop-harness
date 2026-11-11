'use strict';

const FIRST_ORDER_NUMBER = 1001;

function createStore({ products = [], discounts = [] } = {}) {
  return {
    products: new Map(products.map((p) => [p.sku, { ...p }])),
    discounts: new Map(discounts.map((d) => [d.code, { ...d }])),
    orders: new Map(),
    nextOrderNumber: FIRST_ORDER_NUMBER,
  };
}

function seedStore() {
  return createStore({
    products: [
      { sku: 'BOLT-M6', name: 'Hex bolt M6', priceCents: 35, stock: 400 },
      { sku: 'BOLT-M8', name: 'Hex bolt M8', priceCents: 55, stock: 3 },
      { sku: 'NUT-M6', name: 'Hex nut M6', priceCents: 12, stock: 900 },
      { sku: 'NUT-M8', name: 'Hex nut M8', priceCents: 18, stock: 0 },
      { sku: 'WASH-M6', name: 'Washer M6', priceCents: 5, stock: 5 },
      { sku: 'DRILL-18V', name: 'Cordless drill 18V', priceCents: 12999, stock: 7 },
      { sku: 'SAW-CIRC', name: 'Circular saw', priceCents: 8950, stock: 2 },
      { sku: 'TAPE-5M', name: 'Tape measure 5 m', priceCents: 999, stock: 40 },
    ],
    discounts: [
      { code: 'SPRING15', kind: 'percent', value: 15 },
      { code: 'TRADE10', kind: 'percent', value: 10 },
      { code: 'WELCOME5', kind: 'fixed', value: 500 },
      { code: 'LOYAL2', kind: 'fixed', value: 200 },
    ],
  });
}

module.exports = { createStore, seedStore };
