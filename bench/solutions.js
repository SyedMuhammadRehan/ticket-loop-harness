'use strict';
// One correct change per code ticket, as exact replacements against bench/app. They are the
// proof that each oracle can be satisfied, and what a good run's diff should resemble. Never
// copied into a generated repo.

const STATUS_ANCHOR = "  BAD_AMOUNT: 400,\n};";

module.exports = {
  T01: [
    {
      file: 'src/catalog.js',
      find: '  const start = page * pageSize;',
      replace: '  const start = (page - 1) * pageSize;',
    },
  ],

  T02: [
    {
      file: 'src/inventory.js',
      find: 'module.exports = { reserve, release };',
      replace:
        'const DEFAULT_LOW_STOCK_THRESHOLD = 5;\n\n' +
        'function lowStock(store, threshold = DEFAULT_LOW_STOCK_THRESHOLD) {\n' +
        "  if (!Number.isInteger(threshold) || threshold < 0) throw domainError('BAD_THRESHOLD', 'a threshold is a whole number of zero or more');\n" +
        '  return [...store.products.values()]\n' +
        '    .filter((product) => product.stock <= threshold)\n' +
        '    .sort((a, b) => a.stock - b.stock || a.sku.localeCompare(b.sku))\n' +
        '    .map(({ sku, name, stock }) => ({ sku, name, stock }));\n' +
        '}\n\n' +
        'module.exports = { reserve, release, lowStock };',
    },
    {
      file: 'src/http/app.js',
      find: "const { verify } = require('../auth/tokens.js');",
      replace: "const { lowStock } = require('../inventory.js');\nconst { verify } = require('../auth/tokens.js');",
    },
    { file: 'src/http/app.js', find: STATUS_ANCHOR, replace: '  BAD_AMOUNT: 400,\n  BAD_THRESHOLD: 400,\n};' },
    {
      file: 'src/http/app.js',
      find: "    ['POST', /^\\/orders$/, true,",
      replace:
        '    [\n' +
        "      'GET',\n" +
        '      /^\\/inventory\\/low$/,\n' +
        '      true,\n' +
        '      ({ query }) => {\n' +
        "        const text = query.get('threshold');\n" +
        '        return json(200, { items: lowStock(store, text === null ? undefined : Number(text)) });\n' +
        '      },\n' +
        '    ],\n' +
        "    ['POST', /^\\/orders$/, true,",
    },
  ],

  T03: [
    {
      file: 'src/money.js',
      find: '  return Math.floor((cents * percent) / 100);',
      replace: '  return Math.floor((cents * percent + 50) / 100);',
    },
    {
      file: 'src/tax.js',
      find: "const { domainError } = require('./money.js');",
      replace: "const { domainError, percentOf } = require('./money.js');",
    },
    {
      file: 'src/tax.js',
      find: '  return Math.floor((amountCents * rateFor(region)) / 100);',
      replace: '  return percentOf(amountCents, rateFor(region));',
    },
  ],

  T04: [
    {
      file: 'src/auth/tokens.js',
      find: 'const SESSION_TTL_MS = 60 * 60 * 1000;',
      replace: 'const SESSION_TTL_MS = 8 * 60 * 60 * 1000;',
    },
  ],

  T06: [
    {
      file: 'src/discounts.js',
      find: 'module.exports = { applyDiscount, discountAmount, findDiscount };',
      replace:
        '// Several codes on one order: the single percentage code first, on the subtotal, then the\n' +
        '// fixed codes in the order given, each on what is left.\n' +
        'function applyDiscounts(store, subtotalCents, codes) {\n' +
        '  const found = [];\n' +
        '  for (const code of codes) {\n' +
        '    const discount = findDiscount(store, code);\n' +
        "    if (found.includes(discount)) throw domainError('DUPLICATE_CODE', `code ${discount.code} was given twice`);\n" +
        '    found.push(discount);\n' +
        '  }\n' +
        "  const percents = found.filter((discount) => discount.kind === 'percent');\n" +
        "  if (percents.length > 1) throw domainError('ONE_PERCENT_CODE', 'an order takes at most one percentage code');\n" +
        "  const ordered = [...percents, ...found.filter((discount) => discount.kind !== 'percent')];\n" +
        '  let remainingCents = subtotalCents;\n' +
        '  const applied = ordered.map((discount) => {\n' +
        "    const base = discount.kind === 'percent' ? subtotalCents : remainingCents;\n" +
        '    const amountCents = Math.min(discountAmount(base, discount), remainingCents);\n' +
        '    remainingCents -= amountCents;\n' +
        '    return { code: discount.code, amountCents };\n' +
        '  });\n' +
        '  return { discountCents: subtotalCents - remainingCents, applied };\n' +
        '}\n\n' +
        'module.exports = { applyDiscount, applyDiscounts, discountAmount, findDiscount };',
    },
    {
      file: 'src/orders.js',
      find: "const { applyDiscount } = require('./discounts.js');",
      replace: "const { applyDiscounts } = require('./discounts.js');",
    },
    {
      file: 'src/orders.js',
      find:
        'function createOrder(store, { items, region, code = null }) {\n' +
        '  const lines = linesOf(store, items);\n' +
        '  const subtotalCents = lines.reduce((sum, line) => sum + line.lineCents, 0);\n' +
        '  const { discountCents, applied } = applyDiscount(store, subtotalCents, code);',
      replace:
        'function createOrder(store, { items, region, code = null, codes = null }) {\n' +
        '  const lines = linesOf(store, items);\n' +
        '  const subtotalCents = lines.reduce((sum, line) => sum + line.lineCents, 0);\n' +
        '  const { discountCents, applied } = applyDiscounts(store, subtotalCents, codes || (code ? [code] : []));',
    },
    { file: 'src/http/app.js', find: STATUS_ANCHOR, replace: '  BAD_AMOUNT: 400,\n  ONE_PERCENT_CODE: 422,\n  DUPLICATE_CODE: 422,\n};' },
  ],

  T07: [
    {
      file: 'src/orders.js',
      find: '  const order = findOrder(store, id);\n  for (const line of order.lines) release(store, line.sku, line.qty);',
      replace:
        '  const order = findOrder(store, id);\n' +
        "  if (order.status === 'cancelled') throw domainError('ALREADY_CANCELLED', `order ${id} is already cancelled`);\n" +
        "  if (order.status === 'shipped') throw domainError('ALREADY_SHIPPED', `order ${id} has shipped`);\n" +
        '  for (const line of order.lines) release(store, line.sku, line.qty);',
    },
    { file: 'src/http/app.js', find: STATUS_ANCHOR, replace: '  BAD_AMOUNT: 400,\n  ALREADY_CANCELLED: 409,\n  ALREADY_SHIPPED: 409,\n};' },
  ],
};
