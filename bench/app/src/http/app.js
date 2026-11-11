'use strict';
const { search } = require('../catalog.js');
const { createOrder, cancelOrder, findOrder } = require('../orders.js');
const { verify } = require('../auth/tokens.js');

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  UNKNOWN_CODE: 422,
  UNKNOWN_REGION: 422,
  OUT_OF_STOCK: 409,
  NOT_PLACED: 409,
  EMPTY_ORDER: 400,
  BAD_QUANTITY: 400,
  BAD_AMOUNT: 400,
};

const json = (status, body) => ({ status, body });

function userOf(request, secret, now) {
  const header = String((request.headers || {}).authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return verify(secret, token, now);
}

function positiveInteger(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// One entry per route: [method, path pattern, needs a session, handler].
function routes(store) {
  return [
    ['GET', /^\/health$/, false, () => json(200, { ok: true })],
    [
      'GET',
      /^\/products$/,
      false,
      ({ query }) => {
        const page = positiveInteger(query.get('page'), 1);
        const pageSize = positiveInteger(query.get('pageSize'), undefined);
        if (page === null || pageSize === null) return json(400, { error: 'BAD_PAGE' });
        return json(200, search(store, query.get('term') || '', { page, ...(pageSize ? { pageSize } : {}) }));
      },
    ],
    ['POST', /^\/orders$/, true, ({ body }) => json(201, createOrder(store, body || {}))],
    ['GET', /^\/orders\/([\w-]+)$/, true, ({ params }) => json(200, findOrder(store, params[0]))],
    ['POST', /^\/orders\/([\w-]+)\/cancel$/, true, ({ params }) => json(200, cancelOrder(store, params[0]))],
  ];
}

// request: { method, url, headers, body } — returns { status, body }. The Node server in
// server.js is a thin wrapper, so every route is testable without a socket.
function createApp(store, { secret, now = () => Date.now() }) {
  const table = routes(store);
  return function handle(request) {
    const url = new URL(request.url, 'http://depot.local');
    for (const [method, pattern, needsSession, handler] of table) {
      const match = request.method === method && pattern.exec(url.pathname);
      if (!match) continue;
      if (needsSession && !userOf(request, secret, now())) return json(401, { error: 'UNAUTHENTICATED' });
      try {
        return handler({ query: url.searchParams, params: match.slice(1), body: request.body });
      } catch (err) {
        if (err.code && STATUS_BY_CODE[err.code]) return json(STATUS_BY_CODE[err.code], { error: err.code });
        throw err;
      }
    }
    return json(404, { error: 'NO_ROUTE' });
  };
}

module.exports = { createApp, STATUS_BY_CODE };
