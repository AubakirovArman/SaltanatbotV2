# Support

SaltanatbotV2 is community-supported alpha software and has no guaranteed response time or trading-loss coverage.

Before opening an issue:

1. read the README and relevant guide in `docs/`;
2. update to the latest `main` commit and run `npm install`;
3. run `npm run check`, `npm run lint` and the relevant tests;
4. reproduce with `DEMO_MODE=1` or paper mode where possible;
5. remove all secrets, account identifiers and private market data.

Bug reports should include the commit hash, Node/npm versions, operating system, expected and actual behavior, minimal reproduction and sanitized logs. Feature requests should explain the trader workflow and safety implications.

Use a private security advisory for vulnerabilities. General setup questions and reproducible bugs may use GitHub Issues. Never post exchange keys, access tokens, `.env`, `backend/data/` or database files.
