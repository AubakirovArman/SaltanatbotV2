# Asset, screenshot and sample provenance policy

Only commit an image, icon, font, Pine sample or market-data fixture when its origin and license permit
redistribution in this repository.

- Original project screenshots must be captured from `DEMO_MODE=1` or deterministic fixtures. Remove
  access tokens, account IDs, API keys, balances and personally identifying browser content.
- A screenshot PR records capture date, application commit, locale/theme/viewport and author in the
  PR description. Major screenshots live under `docs/screenshots/` and are refreshed when their flow
  materially changes.
- Third-party logos, screenshots, fonts and icons require a source URL, license and attribution file.
  “Found online” is not acceptable provenance.
- Pine corpus files follow `packages/pine-compiler/testdata/corpus/PROVENANCE.json`; CI rejects missing
  or ineligible provenance.
- Market fixtures must be generated or licensed for redistribution and must never contain private
  account/order data.
- AI-generated assets must be labelled as such in provenance and reviewed for trademarks, copied UI,
  embedded text and accidental secrets before inclusion.

The repository license does not override third-party rights. When provenance is uncertain, replace the
asset with a project-owned deterministic capture or omit it.
