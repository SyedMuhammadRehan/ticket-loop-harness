# Depot — architecture

Depot takes orders against a product catalogue and keeps stock honest. It is deliberately
small, but it has the seams a real service has.

## Layers

```
src/http/      request handling: parse, authenticate, call the domain, shape the response
src/auth/      session tokens (signed, expiring)
src/orders.js  the order lifecycle: place, ship, cancel
src/inventory.js, src/catalog.js, src/discounts.js, src/tax.js   domain rules
src/money.js   amounts and percentages
src/store.js   the in-memory state every layer above reads and writes
```

Dependencies point downward only. Nothing under `src/` outside `src/http/` may require
anything from `src/http/`. `npm run lint` enforces this.

## Rules that hold everywhere

1. **Money is integer cents.** No amount is ever a float. Text enters through
   `money.toCents` and leaves through `money.format`.
2. **Percentages round half up to the nearest cent**, and there is one place that does it:
   `money.percentOf`. Discounts and tax both go through it.
3. **Stock never goes negative**, and stock reserved for an order is released exactly once,
   when that order is cancelled.
4. **Domain errors carry a `code`** (`NOT_FOUND`, `OUT_OF_STOCK`, …). The HTTP layer maps codes
   to statuses; it never matches on message text.
5. **The domain is pure of I/O.** Functions take the store and return values or throw.
6. **`src/auth/` is security-sensitive.** A change there needs a human to agree first.

## Order lifecycle

```
placed ──ship──▶ shipped
   │
   └─cancel──▶ cancelled        (stock released)
```

A shipped order cannot be cancelled. A cancelled order cannot be cancelled again or shipped.

## Testing

`npm test` runs `test/*.test.js` with the built-in runner. A test names the behaviour it holds.
`npm run lint` checks strict mode, stray logging and the layering rule.
