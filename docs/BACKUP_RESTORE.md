# Runtime backup and restore

Audience: self-hosted operators
Last verified: 2026-07-11

SaltanatbotV2 stores trading state and encrypted credentials under `backend/data/`. A usable backup
must keep `trading.db` and `.secret` together. The optional candle cache (`candles.db`), bounded
multi-leg paper journal (`arbitrage-paper-multi-leg.sqlite`) and generated access token
(`.authtoken`) are included when present at their default paths.

> A runtime backup contains sensitive material. The database stores exchange credentials encrypted,
> but `.secret` is the root needed to decrypt them. Protect the backup as if it contained plaintext
> credentials. Never commit it, upload it to an untrusted cloud, or send it to a bug report.

## Create an online backup

The application may remain running while creating a backup. SQLite databases are copied through the
online backup API rather than with a raw filesystem copy, then checked with `PRAGMA quick_check`.

```bash
npm run data:backup -- --output ../saltanat-backups/2026-07-11
```

The output directory must not already exist and must be outside `backend/data/`. It contains:

- `trading.db` (required);
- `candles.db` (when present);
- `arbitrage-paper-multi-leg.sqlite` (when present at the default data path);
- `.secret` and `.authtoken` (when present);
- `backup-manifest.json` with format version, sizes and SHA-256 checksums.

Database entries also record SQLite `user_version`, allowing verification to detect unexpected
schema-version drift in addition to byte-level changes.

All copied files and the manifest are written with owner-only `0600` permissions; the backup
directory is created as `0700`.

For a non-default Docker volume mount or a recovery drill, specify the source explicitly:

```bash
npm run data:backup -- --data-dir /srv/saltanat/data --output /srv/backups/saltanat-001
```

If `PAPER_MULTI_LEG_DB_PATH` points outside that data directory, the backup command cannot discover
it; include that custom SQLite file in a separate trusted online-backup policy.

## Verify a backup

Verification detects missing/unmanifested files, symlinks, size/checksum changes, unsupported format
versions and SQLite corruption.

```bash
npm run data:verify -- ../saltanat-backups/2026-07-11
```

Run verification immediately after copying a backup to another disk and before deleting an older
known-good snapshot.

## Restore

1. Stop SaltanatbotV2. Restore must never run against an active server.
2. Verify the selected backup.
3. Restore into the runtime location with the explicit replacement flag.
4. Start the application in paper mode and inspect bots, settings, journals and market history.
5. Keep live trading disarmed until reconciliation and exchange state have been checked.

```bash
npm run data:verify -- ../saltanat-backups/2026-07-11
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

Restore validates the complete backup before touching the target, builds a verified staging
directory, atomically swaps it into place and rolls back the previous directory if the swap fails.
Without `--force`, a non-empty runtime directory is never overwritten. A `.restore-manifest.json`
record remains in the restored directory for local provenance.

To rehearse recovery without touching real state:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

## Recovery policy

- Keep at least two verified generations on separate trusted storage.
- Take a backup before upgrading, changing deployment paths or modifying credentials.
- Test restore periodically into an isolated directory or host.
- Backups are not encrypted by this tool. Use trusted encrypted storage at the filesystem/device
  layer and keep its recovery key separate.
- Restoring local state does not prove the current exchange state. Orders and positions must still
  be reconciled after startup.
