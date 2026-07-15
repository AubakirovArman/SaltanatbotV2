# Security policy

## Supported versions

SaltanatbotV2 is pre-1.0 alpha software. Security fixes are applied to the latest `main` branch; older commits and forks are not supported release channels.

## Reporting a vulnerability

Use the repository's private **Security advisory** form when available. Include affected commit, impact, reproduction steps and a minimal proof of concept. Do not open a public issue containing credentials, exploit details, access tokens, exchange keys or runtime database contents.

If private reporting is unavailable, open a public issue requesting a private contact channel without disclosing the vulnerability. Maintainers should acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

## Secrets and trading safety

- Never attach `backend/data/`, `.secrets/`, `.env`, `.secret`, PostgreSQL dumps, SQLite files or exchange credentials. `.authtoken` is a retired legacy artifact and must also stay private if an old installation still has one.
- Change the generated bootstrap-admin password immediately. New registrations remain pending until an administrator activates them; disabling an account revokes its sessions.
- Use exchange keys without withdrawal permission and restrict them by IP where possible.
- Reproduce trading defects in `DEMO_MODE=1`, paper mode or an exchange testnet.
- Rotate every secret that may have entered logs, screenshots, commits or issue attachments.
- Do not treat synthetic/fallback prices as executable live-market data.

## Scope

Authentication bypasses, secret disclosure, command injection, unsafe order execution, cross-user data access, dependency compromise and denial-of-service flaws are in scope. Strategy profitability, market losses and unsupported Pine semantics are product limitations unless they also cross a documented security boundary.
