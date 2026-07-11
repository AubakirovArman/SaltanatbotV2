# Internationalization and documentation

## Goals

- English is the canonical engineering and API documentation language.
- Russian is the first fully supported product and user-documentation translation.
- The UI is locale-aware and structurally ready for additional languages and RTL.
- Documentation stays versioned with the code and cannot silently describe old behavior.

## Documentation information architecture

```text
docs/
  en/
    getting-started/
    user-guide/
      chart/
      indicators/
      pine-import/
      strategies/
      backtesting/
      paper-trading/
      live-trading/
    reference/
      api/
      pine-compatibility/
      commands/
      configuration/
    operations/
      deployment/
      backup-restore/
      security/
      troubleshooting/
    contributors/
      architecture/
      testing/
      adding-blocks/
      adding-exchanges/
  ru/
    ...same user-facing structure...
  adr/
  assets/
```

Existing root documents should be migrated gradually with redirects/links preserved. Do not duplicate generated API or compatibility tables manually between languages.

## Document classes

- Tutorials: learning-oriented, end-to-end tasks.
- How-to guides: a specific operational outcome.
- Reference: exact APIs, schemas, commands and compatibility.
- Explanation: architecture, execution assumptions and design decisions.
- Safety: live-trading risks, permissions, backup and recovery.

Every page states its audience, applicable version and last verified date where behavior can drift.

## Source-folder README policy

Each maintained source directory has an English `README.md` covering ownership, public API, dependencies, invariants, tests and extension guidance. These are engineering documents and are not duplicated per locale unless contributors need it. User-facing documentation is translated.

## UI internationalization

Introduce a small typed message layer before selecting a larger library:

```text
frontend/src/i18n/
  index.ts
  locale.ts
  messages/
    en.ts
    ru.ts
  format/
    number.ts
    date.ts
    currency.ts
    percent.ts
```

Requirements:

- no new user-facing string directly embedded in a component;
- message IDs are semantic, not copies of English text;
- interpolation is typed;
- pluralization uses `Intl.PluralRules` or ICU semantics;
- numbers, dates, currencies and percentages use `Intl`;
- locale is persisted locally and can default from the browser;
- `<html lang>` and document title update with locale/view;
- layouts use logical CSS properties and are tested with long strings;
- English fallback is explicit and missing translations fail a CI check;
- trading commands, Pine identifiers and API field names remain untranslated code tokens.

## Translation workflow

1. English source message/document changes.
2. CI extracts or compares message keys.
3. Russian translation is updated in the same PR for stable features, or marked with an explicit fallback for experimental copy.
4. Code examples are executed/compiled where possible.
5. Links, headings and screenshots are checked.
6. A native-language review is requested before a stable release.

Machine translation may create a draft, but safety warnings and trading terminology require human review.

## Terminology glossary

Maintain a glossary for terms that must remain consistent, including:

- bar/candle, timeframe, symbol, venue, market type;
- indicator, strategy, signal, intent, order, fill, position;
- backtest, paper trading, live trading, replay;
- stop loss, take profit, trailing stop, liquidation;
- drawdown, slippage, commission, funding, MAE/MFE;
- exact conversion, approximation, display-only and unsupported Pine behavior.

## Generated documentation

Generate rather than hand-maintain:

- REST/WS route index from Express sources (implemented; detailed schemas remain hand-maintained);
- Pine compatibility matrix from corpus metadata (implemented);
- block catalog from block metadata (implemented);
- command reference from command schemas;
- environment variable table from a typed configuration definition;
- release notes from categorized changes.

## Documentation tests

- broken internal/external link checker;
- Markdown lint and heading/anchor validation;
- compile TypeScript/JSON examples;
- execute safe CLI/curl smoke examples against a test server;
- verify all English user pages have Russian counterparts;
- screenshot freshness metadata for major UI changes;
- detect source paths referenced by docs that no longer exist;
- vocabulary check for deprecated or unsafe claims such as “full Pine support” or “production-ready live trading”.

## Required new project documents

- `SECURITY.md`;
- `CODE_OF_CONDUCT.md`;
- `CHANGELOG.md`;
- support and version policy;
- threat model;
- data/storage and backup guide;
- Pine compatibility and fidelity guide;
- backtest methodology and limitations;
- live-trading readiness checklist;
- architecture decision records.

## Documentation definition of done

A feature is documented when:

- user outcome and prerequisites are clear;
- normal path and failure states are shown;
- safety limitations are explicit;
- UI labels match the current application;
- API/schema examples validate;
- English and Russian pages/messages are synchronized according to release status;
- the page is linked from a discoverable index.
