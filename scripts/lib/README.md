# Release-tooling library

This folder contains dependency-free helpers shared by repository maintenance scripts.

- `distribution-manifest.mjs` writes and verifies the strict per-file SHA-256 manifest used by
  release packaging and rollback drills. It also creates same-directory temporary JSON pointer files
  that callers commit with an atomic rename.

Keep these helpers deterministic, non-networked and independent of application runtime state. They
must never read `backend/data`, environment secrets, exchange credentials or user databases.
