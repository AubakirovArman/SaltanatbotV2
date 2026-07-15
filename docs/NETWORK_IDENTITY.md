# Network identity and transfer compatibility

Translations: [Русский](ru/NETWORK_IDENTITY.md) · [Қазақша](kk/NETWORK_IDENTITY.md)

## Status and scope

SaltanatbotV2 now has a versioned, reviewed data contract and a pure fail-closed
evaluator for routes that would require moving an asset between venues. This is
an architectural safety boundary for research and future integration. It is not
a wallet, transfer service, or execution permission.

The server now publishes registry version `network-identity-2026-07-14.v1` with
an exact, reviewed **identity-only** allowlist for Binance and Bybit. It covers
BTC and ETH on their native mainnets plus the official USDT and USDC Ethereum
contracts. Dynamic venue status, fees, limits, confirmations and timing are not
present in this static snapshot, so no listed route is transfer-ready or safe to
execute.

| Asset | Canonical representation | Binance code | Bybit code |
| --- | --- | --- | --- |
| BTC | Bitcoin mainnet native asset | `BTC` | `BTC` |
| ETH | Ethereum mainnet native asset (`eip155:1`) | `ETH` | `ETH` |
| USDT | Ethereum token `0xdAC17F958D2ee523a2206206994597C13D831ec7` | `ETH` | `ETH` |
| USDC | Ethereum token `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `ETH` | `ETH` |

The mapping review is versioned and expires on 2026-10-12. Its official source
set is the [Binance capital schema](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital#all-coins-information),
[Bybit coin-info schema](https://bybit-exchange.github.io/docs/v5/asset/coin-info),
[Bitcoin Core chain parameters](https://github.com/bitcoin/bitcoin/blob/master/src/kernel/chainparams.cpp),
[Bitcoin Core amount units](https://github.com/bitcoin/bitcoin/blob/master/src/consensus/amount.h),
[Ethereum chain ID specification](https://eips.ethereum.org/EIPS/eip-155),
[Ethereum ether denominations](https://ethereum.org/developers/docs/intro-to-ether/#denominations-of-ether),
[Tether supported protocols](https://tether.to/en/supported-protocols/) and
[Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Why a ticker is insufficient

The same ticker can describe different economic assets or representations. A
venue's `network` label is also not a canonical chain identifier. The registry
therefore keeps these concepts separate:

| Layer | Meaning | Examples in tests |
| --- | --- | --- |
| Economic asset | Canonical asset identity; native and wrapped assets are different | `asset:bitcoin`, `asset:tether-usd` |
| Network | Canonical chain namespace/reference and finality assumptions | Bitcoin BIP-122 reference, `eip155:1` |
| Network asset | Exact asset representation on that network | BTC/ETH native, official Ethereum token contract |
| Venue mapping | Exact case-sensitive deposit/withdraw codes and memo/tag policy | reviewed Binance/Bybit codes above |
| Capability evidence | Time-bounded status, fee, limits, confirmations, timing | deliberately absent from the static real registry |

Each identity and capability record carries a reviewed source, version, `asOf`,
and `validUntil`. A registry snapshot has its own schema and registry version.

## Registry ingestion rules

The registry rejects the entire snapshot when any structural invariant fails:

- duplicate canonical IDs or duplicate capability records;
- unknown asset, network, network-asset, mapping, or fee-asset references;
- wrapped-asset cycles or a wrapped representation that disagrees with its
  economic asset identity;
- a native representation attached to a wrapped asset;
- a mapping whose asset differs from its exact network asset;
- a required memo/tag without its declared type, or a memo type on a no-memo
  route;
- unsafe confirmation count below the venue-required count;
- decimal values outside the network asset precision, or minimum above maximum;
- malformed or non-positive evidence validity windows.

Duplicate venue/code lookup tuples are intentionally not silently normalized or
selected. They remain ambiguous, and route evaluation fails closed.

## Preflight compatibility gates

`evaluateTransferCompatibility` is a pure calculation. Wrapped assets and
wrapped network representations are explicitly ineligible. Compatibility is true
only when all of the following hold:

1. The requested asset and both exact, case-sensitive venue network codes resolve
   to one unambiguous reviewed mapping, and the request pins the registry version
   being evaluated.
2. Source and destination resolve to the exact same canonical network-asset ID,
   not merely the same ticker or economic asset.
3. Registry, asset, network, network-asset, mapping, status, limit, fee,
   confirmation, and timing evidence is within its validity and age bounds and
   is not future-dated beyond the allowed clock skew.
4. Withdrawal and deposit are explicitly `enabled`; `unknown`, maintenance, and
   disabled states all fail.
5. The network is explicitly marked non-reorg-sensitive by reviewed evidence.
   Unknown or reorg-sensitive assumptions fail.
6. Memo/tag input exactly follows the destination policy.
7. The withdrawal amount is within source limits. Fixed plus percentage fee is
   calculated with integer decimal units and conservative upward rounding.
8. The amount after fee is positive and within destination deposit limits. A fee
   in another asset is not guessed or converted.
9. The combined processing/arrival estimate fits the caller's timeout.

The result always contains `executable: false` and
`arrivalProofRequired: true`. It can filter or annotate a research route; it
cannot authorize a transfer or order.

## Arrival proof gates

`verifyTransferArrival` independently checks a reviewed read-only observation:

- venue, asset, network, network-asset, and both venue codes exactly match the
  compatible preflight;
- compatibility, initiation, observation, and verification timestamps are
  consistent;
- proof provenance is fresh and time-bounded;
- status is confirmed and confirmations meet the reviewed **safe** count;
- observed amount is not below the fee-adjusted minimum or above the sent gross
  amount;
- arrival and verification remain within the route timeout.

Pending, unknown, reorged, stale, mismatched, late, or under-confirmed proof fails
closed. `verified: true` is a postcondition only and still has
`executable: false`.

## Operator workflow for a future real-data adapter

1. Obtain network metadata from an approved, read-only source. Record the source,
   source version, collection time, review owner/process, and expiry.
2. Review the economic asset separately from chain/network identity and token
   contract. Never infer identity from ticker text.
3. Review each venue's deposit and withdrawal code independently, including
   exact case, memo/tag rule, status, precision, limits, fee asset, fee formula,
   confirmation policy, and timing.
4. Publish a complete new registry version atomically. Do not partially patch a
   live snapshot after failed validation.
5. Quarantine unknown, ambiguous, stale, conflicting, or reorg-sensitive entries.
6. Monitor evidence expiry before using compatibility output in a scanner.
7. Keep execution, credentials, address creation, and transfer submission outside
   this module and behind separate reviewed controls.

## Integration hooks

- `backend/src/market/networkIdentity/registry.ts`: validated immutable snapshot.
- `backend/src/market/networkIdentity/reviewedSnapshot.ts`: reviewed active
  Binance/Bybit identity allowlist and official evidence windows.
- `backend/src/market/networkIdentity/service.ts`: complete validation followed by
  one atomic generation swap; HTTP callers cannot install a snapshot.
- `backend/src/market/networkIdentity/evaluate.ts`: pure preflight and arrival
  postcondition checks.
- `GET /api/network-identity/registry`: bounded public read-only snapshot.
- `POST /api/network-identity/preflight`: strict read-only evaluation against the
  captured server snapshot; caller-supplied registry or mappings are rejected.
- A future protected telemetry adapter may attach fresh capability evidence and proofs.
- A route engine may consume the result only as fail-closed research eligibility.
- Transfer submission, address creation and execution policy remain deliberately
  absent.

See [the module README](../backend/src/market/networkIdentity/README.md) for the
code boundary and the focused
[`networkIdentity.test.ts`](../backend/tests/networkIdentity.test.ts) and
[`networkIdentityRuntime.test.ts`](../backend/tests/networkIdentityRuntime.test.ts)
tests for precision, exact real mappings and fail-closed runtime examples.
