'use strict';
const { domainError } = require('./money.js');

const DEFAULT_PAGE_SIZE = 10;

function findBySku(store, sku) {
  const product = store.products.get(sku);
  if (!product) throw domainError('NOT_FOUND', `no product ${sku}`);
  return product;
}

function search(store, term = '', { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const needle = String(term).trim().toLowerCase();
  const matches = [...store.products.values()]
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const start = page * pageSize;
  return { items: matches.slice(start, start + pageSize), total: matches.length, page, pageSize };
}

module.exports = { findBySku, search, DEFAULT_PAGE_SIZE };
