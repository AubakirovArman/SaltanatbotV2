# Operator-reviewed public research configuration

This folder contains credential-free, non-executable operator configuration that is safe to review
in version control. It must never contain API keys, wallet material, account balances or order
instructions.

`continuous-routes.research.json` is the bounded production public-feed allowlist. Every identity
field exactly matches the central catalog in
`backend/src/market/economicAssetIdentity.ts`; the runtime rejects drift and unknown/wrapped
instruments. The uniform `10` bps taker value is a deliberately conservative public research
assumption, not an account tier or a claim about the venue's current fee schedule. The economics
response therefore continues to mark fee asset, discounts, rebates and exposure impact unverified.

The file enables no trading permission. The runtime remains `readOnly: true`,
`researchOnly: true`, `executable: false` and opens only public market-data subscriptions selected
by the server operator. Long-running services should point
`ARBITRAGE_CONTINUOUS_ROUTES_FILE` at this file with an absolute path. The bounded loader rejects
symlinks, malformed UTF-8, non-regular/oversized files and simultaneous inline JSON configuration.
