# Release-tooling library

This folder contains dependency-free helpers shared by repository maintenance scripts.

- `distribution-manifest.mjs` writes and verifies the strict per-file SHA-256 manifest used by
  release packaging and rollback drills. It also creates same-directory temporary JSON pointer files
  that callers commit with an atomic rename.
- `frontend-publication.mjs` validates and fingerprints staged frontend generations, serializes
  publication with a fail-closed lock, atomically replaces ordinary files then `index.html` then the
  service worker, and exposes the exact active file set to PWA, performance and release consumers.
- `docs-semantic-guard.mjs` validates and compares the deliberately small machine-readable
  capability truth contract and reads the exact generated endpoint-total marker. It does not parse
  arbitrary Markdown or application TypeScript.
- `public-feed-canary.ts` defines the deterministic evidence requirements and bounded schema-v3
  JSON envelope for the networked public-feed canary. Unit tests exercise it without opening
  sockets.
- `public-feed-canary-targets.ts` is the source-backed nine-target scheduled set: one reviewed
  selected instrument for each generic continuous venue. It keeps route-ready versus research-only
  book integrity, exact continuity protocol, and Spot/derivative funding requirements testable
  without importing the networked entry point.

Keep these helpers deterministic, non-networked and independent of application runtime state. They
must never read `backend/data`, environment secrets, exchange credentials or user databases.
