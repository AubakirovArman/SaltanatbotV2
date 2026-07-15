# Public venue plugin conformance

This folder is the versioned, credential-free extension boundary for public venue adapters. Contract
`1.0.x` accepts only the `public-read-only` authority and a zero-argument adapter factory. A plugin
descriptor cannot advertise private execution, borrow, deposit/withdrawal or non-public capability
scopes.

- `types.ts` defines the compile-time descriptor, semantic versions, operation coverage and bounded
  report schema.
- `descriptor.ts` enforces the compatibility range, official-doc review date, unique venue/plugin
  registration and exact capability/factory consistency.
- `invariants.ts` validates bounded JSON snapshots, stable instrument identity, finite prices and
  quantities, uncrossed sorted books, timestamps, funding semantics and duplicate rejection.
- `certification.ts` runs every advertised operation/market pair through happy, pre-cancelled,
  timeout, rate-limit and generic HTTP-failure scenarios. Reports contain at most 128 cases.
- `fakeVenue.ts` is a deterministic synthetic adapter and failure injector for repeatable CI. It is
  not an external venue and its passing report is not evidence about a live exchange.

The suite certifies the public snapshot boundary only. Streaming sequence recovery, credential-free
live canaries and all private order/account behavior require separate gates.
