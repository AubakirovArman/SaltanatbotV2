import type { Page, Route } from "@playwright/test";
import {
  ALERT_RULE_LIST_SCHEMA_V1,
  parseAlertRuleDocumentV1,
  parseAlertRuleRecordV1,
  type AlertRuleDocumentV1,
  type AlertRuleRecordV1
} from "@saltanatbotv2/contracts";
import {
  installR52ScreenerFixture,
  R52_CSRF,
  R52_OWNER_ID,
  type R52ScreenerFixture,
  type R52ScreenerRequest
} from "./r52ScreenerFixture";

export const R53B_BINDING_ID = "60000000-0000-4000-8000-000000000531";
export const R53B_BINDING_HANDLE = "1a2b3c4d";
export const R53B_BINDING_REVISION = 3;
/** Raw one-consume code (26 lowercase base32 chars, like the backend emits). */
export const R53B_BINDING_CODE = "telegrambindcode234567abcd";
export const R53B_CODE_EXPIRES_AT = "2026-07-16T20:10:00.000Z";
export const R53B_PRICE_RULE_ID = "60000000-0000-4000-8000-000000000532";

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const BINDING_CREATED_AT = "2026-07-16T19:30:00.000Z";
const BINDING_ACTIVATED_AT = "2026-07-16T19:31:00.000Z";
const BINDING_REVOKED_AT = "2026-07-16T20:05:00.000Z";
const RULE_CREATED_AT = "2026-07-16T20:02:00.000Z";

interface MutableBinding {
  id: string;
  status: "pending" | "active" | "revoked";
  revision: number;
  recipientHandle: string;
  createdAt: string;
  activatedAt?: string;
  revokedAt?: string;
}

export interface R53bTelegramBindingFixture extends R52ScreenerFixture {
  readonly bindingRequests: R52ScreenerRequest[];
  readonly alertCreates: R52ScreenerRequest[];
  readonly alertUpdates: R52ScreenerRequest[];
}

/**
 * Extends the fail-closed R5.2 fixture with the R5.3b-1 Telegram binding
 * lifecycle: GET /api/alerts/bindings, POST /codes (the raw code is issued
 * exactly once, then the outstanding-code quota answers 429), POST
 * /:id/revoke fenced on expectedRevision, and the price-threshold rule
 * creation that must arm the telegram channel. The reconciler's contract is
 * enforced exactly: POST /api/alerts must carry the disabled draft, the
 * follow-up PUT enables it under an expectedRevision fence, and both must
 * happen while the binding is still active. Every payload is validated before
 * the mock accepts it, so a drifted client fails the journey instead of
 * silently succeeding; GET /api/alerts reflects created rules so later
 * refreshes stay consistent. No request reaches a database or Telegram.
 */
export async function installR53bTelegramBindingFixture(page: Page): Promise<R53bTelegramBindingFixture> {
  const base = await installR52ScreenerFixture(page);
  const bindingRequests: R52ScreenerRequest[] = [];
  const alertCreates: R52ScreenerRequest[] = [];
  const alertUpdates: R52ScreenerRequest[] = [];
  const createdRules: AlertRuleRecordV1[] = [];
  const binding: MutableBinding = {
    id: R53B_BINDING_ID,
    status: "active",
    revision: R53B_BINDING_REVISION,
    recipientHandle: R53B_BINDING_HANDLE,
    createdAt: BINDING_CREATED_AT,
    activatedAt: BINDING_ACTIVATED_AT
  };
  let issuedCodes = 0;

  await page.route("**/api/alerts", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    if (ownerHeader !== R52_OWNER_ID) {
      base.violations.push(`${request.method()} ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }
    if (request.method() === "GET") {
      return json(route, {
        schemaVersion: ALERT_RULE_LIST_SCHEMA_V1,
        rules: createdRules,
        generatedAt: RULE_CREATED_AT,
        researchOnly: true,
        executionPermission: false
      });
    }
    if (request.method() !== "POST") return route.fallback();

    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = parseBody(request.postData());
    alertCreates.push({ method: "POST", path: pathname, ownerHeader, csrfHeader, ...(body ? { body } : {}) });
    if (csrfHeader !== R52_CSRF) {
      base.violations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
      return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
    }
    const problem = telegramAlertCreateProblem(body, binding);
    if (problem !== undefined) {
      base.violations.push(`POST ${pathname}: ${problem}`);
      return json(route, { code: "invalid_request", error: "Invalid price alert rule." }, 400);
    }
    const rule = parseAlertRuleRecordV1({
      schemaVersion: "alert-rule-record-v1",
      id: R53B_PRICE_RULE_ID,
      clientId: body!.clientId,
      revision: 1,
      definition: body!.definition,
      lifecycleState: "armed",
      createdAt: RULE_CREATED_AT,
      updatedAt: RULE_CREATED_AT,
      researchOnly: true,
      executionPermission: false
    });
    createdRules.push(rule);
    return json(route, { rule }, 201);
  });

  // The reconciler enables the disabled draft with a revision-fenced PUT.
  await page.route("**/api/alerts/*", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ruleMatch = pathname.match(/^\/api\/alerts\/([^/]+)$/u);
    if (request.method() !== "PUT" || !ruleMatch) return route.fallback();
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = parseBody(request.postData());
    alertUpdates.push({ method: "PUT", path: pathname, ownerHeader, csrfHeader, ...(body ? { body } : {}) });
    if (ownerHeader !== R52_OWNER_ID) {
      base.violations.push(`PUT ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }
    if (csrfHeader !== R52_CSRF) {
      base.violations.push(`PUT ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
      return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
    }
    const existingIndex = createdRules.findIndex((rule) => rule.id === decodeURIComponent(ruleMatch[1]!));
    const existing = existingIndex < 0 ? undefined : createdRules[existingIndex]!;
    if (!existing) {
      base.violations.push(`PUT ${pathname}: unknown rule`);
      return json(route, { code: "alert_rule_not_found", error: "Alert rule not found." }, 404);
    }
    const problem = telegramAlertUpdateProblem(body, existing, binding);
    if (problem !== undefined) {
      base.violations.push(`PUT ${pathname}: ${problem}`);
      return json(route, { code: "invalid_request", error: "Invalid price alert update." }, 400);
    }
    const updated = parseAlertRuleRecordV1({
      schemaVersion: "alert-rule-record-v1",
      id: existing.id,
      clientId: existing.clientId,
      revision: existing.revision + 1,
      definition: body!.definition,
      lifecycleState: "armed",
      createdAt: existing.createdAt,
      updatedAt: RULE_CREATED_AT,
      researchOnly: true,
      executionPermission: false
    });
    createdRules[existingIndex] = updated;
    return json(route, { rule: updated });
  });

  await page.route("**/api/alerts/bindings**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = parseBody(request.postData());
    bindingRequests.push({ method: request.method(), path: pathname, ownerHeader, csrfHeader, ...(body ? { body } : {}) });

    if (url.search !== "") {
      base.violations.push(`${request.method()} ${pathname}: unexpected query ${url.search}`);
      return json(route, { code: "invalid_request", error: "Binding query has unknown fields." }, 400);
    }
    if (ownerHeader !== R52_OWNER_ID) {
      base.violations.push(`${request.method()} ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "alert_owner_mismatch", error: "The authenticated alert owner changed." }, 409);
    }

    if (request.method() === "GET" && pathname === "/api/alerts/bindings") {
      return json(route, { bindings: [publicBinding(binding)], researchOnly: true, executionPermission: false });
    }
    if (request.method() !== "POST") {
      base.unexpectedApiRequests.push(`${request.method()} ${pathname}`);
      return json(route, { code: "unexpected_binding_request", error: `${request.method()} ${pathname}` }, 501);
    }
    if (csrfHeader !== R52_CSRF) {
      base.violations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
      return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
    }

    if (pathname === "/api/alerts/bindings/codes") {
      if (body === undefined || Object.keys(body).length !== 0) {
        base.violations.push(`POST ${pathname}: code request body must be an empty object`);
        return json(route, { code: "invalid_request", error: "Binding code request takes no body fields." }, 400);
      }
      issuedCodes += 1;
      if (issuedCodes > 1) {
        // Mirrors the repository-enforced outstanding-code quota surface.
        return json(route, { code: "binding_code_quota_exceeded", error: "At most 3 unconsumed binding codes may be outstanding." }, 429);
      }
      return json(route, {
        code: R53B_BINDING_CODE,
        codeId: "60000000-0000-4000-8000-000000000533",
        expiresAt: R53B_CODE_EXPIRES_AT,
        researchOnly: true,
        executionPermission: false
      }, 201);
    }

    const revokeMatch = pathname.match(/^\/api\/alerts\/bindings\/([^/]+)\/revoke$/u);
    if (revokeMatch) {
      if (decodeURIComponent(revokeMatch[1]!) !== binding.id) {
        return json(route, { code: "binding_not_found", error: "Binding not found." }, 404);
      }
      const problem = revokeProblem(body, binding);
      if (problem !== undefined) {
        base.violations.push(`POST ${pathname}: ${problem.detail}`);
        return json(route, { code: problem.code, error: problem.detail }, problem.status);
      }
      binding.status = "revoked";
      binding.revision += 1;
      binding.revokedAt = BINDING_REVOKED_AT;
      return json(route, { binding: publicBinding(binding), cancelledDeliveries: 1 });
    }

    base.unexpectedApiRequests.push(`POST ${pathname}`);
    return json(route, { code: "unexpected_binding_request", error: `POST ${pathname}` }, 501);
  });

  return { ...base, bindingRequests, alertCreates, alertUpdates };
}

function telegramAlertCreateProblem(body: Record<string, unknown> | undefined, binding: MutableBinding): string | undefined {
  if (!body) return "missing body";
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "clientId,definition") return `unexpected envelope keys ${keys}`;
  if (typeof body.clientId !== "string" || !CLIENT_ID.test(body.clientId)) return "invalid clientId";
  const definition = telegramDefinitionProblemFreeParse(body.definition, binding);
  if (typeof definition === "string") return definition;
  // The reconciler always commits the browser fence first: drafts arrive disabled.
  if (definition.enabled !== false) return "created draft must be disabled";
  return undefined;
}

function telegramAlertUpdateProblem(
  body: Record<string, unknown> | undefined,
  existing: AlertRuleRecordV1,
  binding: MutableBinding
): string | undefined {
  if (!body) return "missing body";
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "definition,expectedRevision") return `unexpected envelope keys ${keys}`;
  if (body.expectedRevision !== existing.revision) return `expectedRevision ${String(body.expectedRevision)} does not match revision ${existing.revision}`;
  const definition = telegramDefinitionProblemFreeParse(body.definition, binding);
  if (typeof definition === "string") return definition;
  if (definition.enabled !== true) return "update must enable the fenced draft";
  return undefined;
}

function telegramDefinitionProblemFreeParse(value: unknown, binding: MutableBinding): AlertRuleDocumentV1 | string {
  let definition: AlertRuleDocumentV1;
  try {
    definition = parseAlertRuleDocumentV1(value);
  } catch (error) {
    return `invalid definition: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (definition.kind !== "price-threshold") return `kind ${definition.kind}`;
  if (definition.deliveryChannels.join(",") !== "in-app,telegram") return "journey rule must arm in-app and telegram delivery";
  if (binding.status !== "active") return "telegram channel armed without an active binding";
  if (definition.researchOnly !== true || definition.executionPermission !== false) return "safety envelope violated";
  return definition;
}

function revokeProblem(
  body: Record<string, unknown> | undefined,
  binding: MutableBinding
): { status: number; code: string; detail: string } | undefined {
  if (!body || Object.keys(body).sort().join(",") !== "expectedRevision") {
    return { status: 400, code: "invalid_request", detail: "revoke body must contain exactly expectedRevision" };
  }
  if (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
    return { status: 400, code: "invalid_request", detail: "expectedRevision is invalid" };
  }
  if (binding.status !== "active" || body.expectedRevision !== binding.revision) {
    return { status: 409, code: "binding_revision_conflict", detail: `expectedRevision ${body.expectedRevision} does not match revision ${binding.revision} (${binding.status})` };
  }
  return undefined;
}

function publicBinding(binding: MutableBinding): Record<string, unknown> {
  return {
    id: binding.id,
    status: binding.status,
    revision: binding.revision,
    recipientHandle: binding.recipientHandle,
    createdAt: binding.createdAt,
    ...(binding.activatedAt ? { activatedAt: binding.activatedAt } : {}),
    ...(binding.revokedAt ? { revokedAt: binding.revokedAt } : {})
  };
}

function parseBody(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  });
}
