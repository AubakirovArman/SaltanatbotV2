## What changed

Describe the user/developer outcome and the narrow scope of this pull request.

## Why

Link the issue or explain the defect, risk or architectural boundary being addressed.

## Verification

- [ ] `npm run check`
- [ ] `npm run lint`
- [ ] `npm run docs:check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e` for user-visible, API or persistence changes, or a reason is given below

Evidence, fixtures or commands:

## Safety and compatibility

- [ ] No secrets, `backend/data`, private exchange/account/order identifiers or credentials are included.
- [ ] Live/mutating paths fail closed and are not automatically retried after ambiguous outcomes.
- [ ] Pine exact/approximate/unsupported behavior is explicit and compatibility artifacts are current.
- [ ] Schema/API/IR/storage changes include versioning, migration and backward-compatibility coverage.
- [ ] Documentation and supported translations changed with the behavior.
- [ ] Accessibility, keyboard operation and reduced motion were considered for UI changes.

## Screenshots or traces

Attach sanitized evidence when it materially helps review. Never attach runtime databases, HAR files
with authorization headers, exchange credentials or real private account data.
