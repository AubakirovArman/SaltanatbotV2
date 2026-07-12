# Frontend source

The frontend is the React composition layer for charting, strategy research and trading operations.

## Public entry points

- `main.tsx` mounts the application.
- `App.tsx` composes the three top-level workspaces.
- Feature code should be imported through its local public entry point where one exists.

## Boundaries

- Components may depend on hooks and feature APIs, not backend implementation details.
- Pure chart, strategy and trading rules belong outside React components.
- Network access is centralized under `api/` or feature-specific clients.
- Persistent browser state is accessed through named storage modules, not ad hoc keys in new components.
- `pwa/` registers the generated production-only offline shell; it must never cache APIs, credentials, streams or trading mutations.
- New user-facing strings should use the planned typed i18n layer.

## Invariants

- Strategy code is interpreted as validated IR; never use `eval` or generated JavaScript.
- Heavy workspaces remain lazy-loaded.
- Chart-only information needs a semantic DOM alternative.
- Dialogs, menus, forms and keyboard shortcuts must be accessible.

## Tests

Pure domain behavior uses Vitest. React behavior should use component tests, and critical Chart/Strategy/Trade journeys belong in Playwright. See `docs/TESTING_STRATEGY.md`.

## Planned decomposition

`App.tsx` is now a small workspace composition root. Strategy artifacts belong to `strategy/useArtifactLibrary.ts`, async chart artifacts to `chart/useChartArtifactOverlay.ts`, and cross-workspace preferences/workspaces/commands to the `app/` controllers. See `docs/MODULAR_ARCHITECTURE.md`.
