# Distribution incident response and rollback

This runbook covers a broken, incomplete or tampered SaltanatbotV2 application distribution. It
does not make live trading production-ready and it does not automatically reverse database schema
migrations, exchange orders or positions.

## Release evidence

Every release workflow produces and attests:

- the immutable application archive and `release-info.json`;
- an external `*.distribution-manifest.json`, identical to the manifest inside the archive;
- an SPDX SBOM;
- `SHA256SUMS` covering those files and the rollback-drill report;
- `*.rollback-drill.json`, proving the exact staged distribution detected controlled corruption and
  restored a verified immutable slot;
- Sigstore provenance and SBOM bundles.

The internal manifest contains the sorted relative path, byte size and SHA-256 of every distribution
file. Verification rejects missing, extra, changed, symbolic-link and unsupported filesystem
entries. Release identity must also match `release-info.json`.

## Automated drill

After `npm run build`, create and exercise a local-only package:

```bash
ALLOW_DIRTY_RELEASE=1 npm run release:package -- --channel nightly --version nightly-local-drill
npm run release:rollback-drill -- \
  --distribution .release-staging/saltanatbotv2-nightly-local-drill \
  --output release/saltanatbotv2-nightly-local-drill.rollback-drill.json
```

`ALLOW_DIRTY_RELEASE=1` is only for a local rehearsal and remains recorded in release metadata. A
publishable artifact must come from a clean protected workflow.

The drill copies the verified distribution into immutable `candidate` and `previous` slots inside an
isolated temporary directory. It atomically points at the candidate, adds a controlled marker to the
candidate HTML, requires manifest verification to block it, atomically points back to the previous
slot, re-verifies the previous slot and confirms the original distribution was not modified. It
never opens `backend/data` and records `runtimeDataTouched: false`.

## Real incident sequence

1. **Contain.** Stop promotion and new deployments. If exchange execution may be affected, disarm
   live operation and verify open orders/positions directly at each venue; application rollback does
   not cancel them.
2. **Preserve evidence.** Record the release version, commit, deployment time, operator, alert,
   console/server logs and the downloaded `SHA256SUMS`, manifests and Sigstore bundles. Do not edit
   the suspect slot in place.
3. **Verify the last known-good release.** Check SHA-256 and GitHub attestations from a clean machine.
   Extract to a new immutable directory and verify its internal distribution manifest.
4. **Check data compatibility.** A binary rollback does not reverse migrations. Stop the application
   and use [Backup and restore](BACKUP_RESTORE.md) only when the previous binary cannot safely read
   the current schema. Never restore a database while either binary is running.
5. **Stage and probe.** Start the previous release on an isolated port with the intended configuration.
   Verify `/api/health`, static assets, authentication, expected demo/live arming state and required
   WebSocket upgrades without sending a live order.
6. **Switch atomically.** Change one same-filesystem symlink/pointer or reverse-proxy upstream to the
   verified slot. Never partially overwrite the active directory.
7. **Observe and reconcile.** Confirm UI release identity, API health, streams, bot desired/actual
   state and venue orders/positions. Keep the suspect slot and evidence read-only for investigation.
8. **Close deliberately.** Document root cause, affected versions, user impact, recovery timestamps
   and follow-up tests. Publish a new version; never replace assets under an existing tag.

## Acceptance criteria

A drill or incident is not complete unless:

- every checksum and attestation names the expected repository and commit;
- corruption detection fails closed before a bad slot can be approved;
- the active pointer identifies the verified previous slot after rollback;
- the final distribution manifest matches the known-good digest;
- runtime-data handling and venue reconciliation are recorded explicitly;
- evidence contains no credentials, tokens, exchange payload secrets or personal data.

The repository drill proves distribution integrity and atomic selection mechanics. Each real hosting
platform must additionally rehearse its own proxy, process supervisor, persistent volumes and access
controls before that deployment can claim stable rollback readiness.
