# Protected research-alert operator UI

This folder owns the authenticated browser workspace for generic cross-family
research notifications.

- `ResearchAlertPanel.tsx` loads the combined policy/outbox state, pauses polling
  in hidden tabs, and coordinates create, edit and confirmed delete mutations.
- `ResearchAlertPolicyEditor.tsx` mirrors the backend policy bounds with native
  semantic controls. It never accepts exchange credentials or order input.
- `ResearchAlertTables.tsx` renders bounded policy and delivery tables, including
  economics, capacity, evidence freshness, cooldowns, retry status and errors.
- Transport, strict response parsing, types and EN/RU/KK copy live one level up
  in `researchAlertClient.ts`, `researchAlertParser.ts`,
  `researchAlertTypes.ts` and `researchAlertText.ts`.

Every response must prove `researchOnly: true` and
`executionPermission: false`. Unknown response fields fail closed before React
state is updated. Mutations use the existing internal cookie session and CSRF
transport; no bearer token, secret or order capability is introduced here.

Integration hook: render `<ResearchAlertPanel locale={locale} />` only inside an
already authenticated `paper-trade`, `live-trade` or `admin` workspace. Import
the panel directly or add a lazy loader; the component imports its isolated CSS.
