# Selected triangular depth verification

The venue-wide REST scan is a cheap candidate generator. This module performs the second stage for
one explicitly selected Binance or Bybit spot triangle: it acquires all three books from the bounded
sequence-reconstructed L2 hub, checks the connection-generation leases before and after simulation,
and runs the transport-free triangular engine with venue filters and visible multi-level depth.

The HTTP response is public, read-only research data. `executable: false` and `execution: none` are
permanent API boundaries: sequence verification proves market-data continuity, not account balance,
margin, simultaneous fills or permission to place orders. A route may be passed separately to the
protected paper journal, but this module has no credentials or order transport.
