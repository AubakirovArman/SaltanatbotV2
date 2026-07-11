# Migration notes

SaltanatbotV2 uses forward-only runtime migrations and versioned portable browser artifacts. Back up
runtime data before upgrading and never open a database with an older application after a forward
migration.

## Unreleased / schema baseline 2

- Trading SQLite state is upgraded transactionally through ordered `schema_migrations`; a database
  declaring a newer unsupported version is rejected without mutation.
- Strategy/indicator artifacts stored in the browser migrate from implicit schema 1 to schema 2 by
  adding semantic version, bounded immutable history, parameters, dependencies and provenance.
- Legacy `.strategy` envelope v1 can be imported through an explicit unverified migration path. New
  exports are checksum-verified schema-v2 envelopes; import never silently downgrades them.
- Chart workspace exports use schema 2 with SHA-256 verification and bounded revisions. Existing local
  workspaces are normalized on read and preserved by ID.

For server data, follow [Backup and restore](BACKUP_RESTORE.md) before deployment. A breaking future
IR, API, storage or event-trace change must add a dated section here and executable backward-compatibility
coverage in the same change.
