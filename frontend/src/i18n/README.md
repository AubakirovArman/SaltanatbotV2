# Frontend internationalization

This directory owns the typed EN/RU/KK application locale boundary. `index.ts` defines the stable
locale registry, persistence, direction and regional format tags. Domain facades expose semantic
keys for shell, chart, market structure, Strategy Studio and Trading.

English defines each canonical key union. Russian and Kazakh records must satisfy it at compile time;
components must use a domain translator or `localized()` instead of binary locale conditionals.
Pine identifiers, Antares commands, API fields and exchange symbols remain untranslated tokens.

Verification lives in the localization unit suites and the production Playwright locale journey.
