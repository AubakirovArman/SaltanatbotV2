# External Pine samples

This directory contains real-world Pine scripts used to audit parser failure
modes. It is not a general script library and inclusion does not imply that a
script is safe, correct or supported.

[`provenance.json`](./provenance.json) records the source page, author, acquired
date, SPDX license decision, corpus eligibility and exact SHA-256 for every
checked-in `.pine` file. Only `corpusEligible: true` files may run as compiler
corpus tests. Files with `LicenseRef-Unknown` remain audit-only and must not be
copied into fixtures, documentation or releases that claim permissive licensing.

Run `npm run pine:provenance:check` after any change. A new eligible sample must:

1. link to the author's primary publication;
2. preserve its license and attribution header;
3. use an allow-listed OSI-approved SPDX identifier;
4. record the exact file hash and acquisition date;
5. pass deterministic typed-outcome tests without network access.

MPL-2.0 samples remain under MPL-2.0. See their headers and source pages for
attribution; modifications to those files must retain the notices.
