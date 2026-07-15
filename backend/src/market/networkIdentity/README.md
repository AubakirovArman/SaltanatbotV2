# Network identity boundary

This module is the fail-closed identity boundary for research routes that would
require an asset transfer. It deliberately does **not** hold credentials, call
deposit/withdraw/order APIs, create addresses, or authorize execution.

## Model

- `CanonicalAssetIdentity` describes the economic asset. Native and wrapped
  assets are separate identities.
- `CanonicalNetworkIdentity` describes the exact chain/network and its finality
  assumptions.
- `CanonicalNetworkAssetIdentity` binds one asset to one network representation:
  native, token contract, or reviewed wrapped contract.
- `VenueTransferNetworkMapping` maps exact, case-sensitive venue deposit and
  withdrawal codes to that network asset and memo/tag policy.
- `VenueTransferCapabilityEvidence` is separately reviewed, time-bounded dynamic
  evidence for status, limits, fees, confirmations, and timing.

`NetworkIdentityRegistry` validates the whole versioned snapshot before exposing
an immutable view. Unknown references, duplicate IDs, wrapper cycles, invalid
precision, invalid limits, and incomplete memo rules are rejected at ingestion.
Duplicate venue/code lookup tuples are retained so route evaluation can report
them as ambiguous and fail closed.

`reviewedSnapshot.ts` supplies the expiring `network-identity-2026-07-14.v1`
identity-only allowlist for BTC, ETH, Ethereum USDT and Ethereum USDC across
Binance and Bybit. It contains no dynamic transfer capabilities. `service.ts`
captures one immutable generation per operation and validates a complete next
document before an atomic swap.

## Evaluation boundaries

`evaluateTransferCompatibility` rejects wrapped identities and requires exact source/destination canonical
network-asset equality, a caller-pinned registry version, fresh reviewed identity and capability evidence, enabled
withdrawal and deposit, exact decimal fee and bound checks, a non-reorg-sensitive
network declaration, and an arrival estimate within the requested timeout.

`verifyTransferArrival` additionally requires a matching reviewed proof, safe
confirmations, an amount within the preflight bounds, and observation within the
route timeout. Both results always contain `executable: false`; callers must not
treat them as transfer or order authorization.

## Integration hooks

1. `GET /api/network-identity/registry` returns the bounded read-only server
   snapshot; `POST /api/network-identity/preflight` evaluates a strict request
   against that snapshot and rejects caller-supplied registry fields.
2. A protected telemetry adapter can produce a complete next registry document
   from explicitly reviewed venue metadata and current capability evidence.
3. A route planner can construct an exact preflight request and consume the pure
   compatibility result before showing a research route.
4. A transfer observer can translate read-only deposit history into an arrival
   proof and call the postcondition verifier.
5. Address creation, transfer submission and execution policy remain outside
   this module.

Real mappings prove identity only. Synthetic fixtures cover positive arithmetic;
neither the real nor synthetic rows authorize a transfer.
