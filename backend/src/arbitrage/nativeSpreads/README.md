# Venue-native spread scanner

This folder contains the read-only Bybit Spread Trading adapter, scanner service,
HTTP route and normalized contracts. It is deliberately separate from synthetic
spot/perpetual and triangular engines: the prices here come from Bybit's own
multi-leg combination order book.

Safety invariants: public endpoints only, bounded pagination/concurrency/payload,
strict response validation, both book sides required, stale/future timestamps
rejected, malformed rows never promoted to opportunities, and no private order
execution. A displayed quote is not a promise of a fill; clients must revalidate
the instrument, book, fees, collateral and account eligibility before trading.
