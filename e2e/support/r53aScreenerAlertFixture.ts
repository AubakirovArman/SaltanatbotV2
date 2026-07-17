import type { Page, Route } from "@playwright/test";
import { parseAlertRuleDocumentV1, parseAlertRuleRecordV1, type AlertRuleDocumentV1 } from "@saltanatbotv2/contracts";
import {
  installR52ScreenerFixture,
  R52_CSRF,
  R52_OWNER_ID,
  type R52ScreenerFixture,
  type R52ScreenerRequest
} from "./r52ScreenerFixture";

export const R53A_ALERT_RULE_ID = "50000000-0000-4000-8000-000000000053";
export const R53A_ALERT_CREATED_AT = "2026-07-16T20:02:00.000Z";

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export interface R53aScreenerAlertFixture extends R52ScreenerFixture {
  readonly alertCreates: R52ScreenerRequest[];
}

/**
 * Extends the fail-closed R5.2 screener fixture with the single write route of
 * the R5.3a promotion journey: POST /api/alerts. The submitted definition is
 * re-parsed with the shared contracts before the mock accepts it, so a drifted
 * client payload fails the journey instead of silently succeeding. The first
 * create succeeds; every further create answers the per-owner screener-alert
 * quota, letting the journey assert the 429 error surface without a second
 * fixture. GET traffic falls through to the R5.2 read-only alert mocks.
 */
export async function installR53aScreenerAlertFixture(page: Page): Promise<R53aScreenerAlertFixture> {
  const base = await installR52ScreenerFixture(page);
  const alertCreates: R52ScreenerRequest[] = [];
  let createdCount = 0;

  await page.route("**/api/alerts", (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = parseBody(request.postData());
    alertCreates.push({
      method: "POST",
      path: pathname,
      ownerHeader,
      csrfHeader,
      ...(body ? { body } : {})
    });

    if (ownerHeader !== R52_OWNER_ID) {
      base.violations.push(`POST ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }
    if (csrfHeader !== R52_CSRF) {
      base.violations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
      return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
    }
    const problem = alertCreateProblem(body);
    if (problem !== undefined) {
      base.violations.push(`POST ${pathname}: ${problem}`);
      return json(route, { code: "invalid_request", error: "Invalid screener alert rule." }, 400);
    }
    if (createdCount > 0) {
      return json(route, { code: "screener_alert_quota_exceeded", error: "Too many enabled screener alerts for this owner." }, 429);
    }
    createdCount += 1;
    return json(route, {
      rule: parseAlertRuleRecordV1({
        schemaVersion: "alert-rule-record-v1",
        id: R53A_ALERT_RULE_ID,
        clientId: body!.clientId,
        revision: 1,
        definition: body!.definition,
        lifecycleState: "armed",
        createdAt: R53A_ALERT_CREATED_AT,
        updatedAt: R53A_ALERT_CREATED_AT,
        researchOnly: true,
        executionPermission: false
      })
    }, 201);
  });

  return { ...base, alertCreates };
}

function alertCreateProblem(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return "missing body";
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "clientId,definition") return `unexpected envelope keys ${keys}`;
  if (typeof body.clientId !== "string" || !CLIENT_ID.test(body.clientId)) return "invalid clientId";
  let definition: AlertRuleDocumentV1;
  try {
    definition = parseAlertRuleDocumentV1(body.definition);
  } catch (error) {
    return `invalid definition: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (definition.kind !== "screener") return `kind ${definition.kind}`;
  if (definition.deliveryChannels.join(",") !== "in-app") return "delivery channels must stay in-app until R5.3b";
  if (definition.repeat !== "on-change") return "repeat must be on-change";
  if (definition.enabled !== true) return "promoted rule must be enabled";
  if (definition.researchOnly !== true || definition.executionPermission !== false) return "safety envelope violated";
  return undefined;
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
