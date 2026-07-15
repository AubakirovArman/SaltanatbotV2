# Arbitrage research engines

This folder contains transport-free evaluators. HTTP discovery, exchange adapters, persistence and
order execution stay outside the engines so recorded inputs can be replayed deterministically.

- `triangular/` simulates three directed spot legs with depth, fee and step rounding after every leg.
- `nLeg/` generates bounded simple 4–8-leg spot cycles and simulates exact asset/unit, side-specific fee, depth, lot and residual conservation.
- `pairwise/` evaluates one explicitly supplied two-instrument route and its inventory, funding,
  settlement and conversion assumptions.
- `optionsParity/` evaluates European put/call parity, conversion/reversal, boxes and synthetics.

Every engine is fail-closed and labels research output as non-executable. Adding an engine requires
its own typed inputs, bounded loops, deterministic tests, a folder README and an explicit transport
adapter before it can become reachable over HTTP.
