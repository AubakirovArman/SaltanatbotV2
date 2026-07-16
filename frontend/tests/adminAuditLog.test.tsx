// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuditLog } from "../src/admin/AdminAuditLog";
import { authText } from "../src/auth/messages";

const ROMAN_ID = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("administrator audit log", () => {
  it("renders actor, target, reason and before/after state and sends filters to the server", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requests.push(new URL(String(input), "http://localhost"));
        return json({
          events: [
            {
              id: "91",
              eventType: "user.permissions_changed",
              actorLogin: "owner",
              subjectLogin: "roman",
              reason: "Approved paper pilot.",
              before: { status: "active", appRole: "user", tradingRole: "none", authorizationRevision: 2 },
              after: { status: "active", appRole: "user", tradingRole: "paper-trade", authorizationRevision: 3 },
              metadata: {},
              occurredAt: "2026-07-16T12:00:00.000Z"
            }
          ],
          page: 1,
          pageSize: 25,
          total: 1,
          totalPages: 1
        });
      })
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<AdminAuditLog locale="en" />));
    await vi.waitFor(() => expect(container.querySelector(".auth-audit-card")?.textContent).toContain("Approved paper pilot."));
    expect(container.querySelector(".auth-audit-card")?.textContent).toContain("owner");
    expect(container.querySelector(".auth-audit-card")?.textContent).toContain("roman");
    expect(container.querySelector(".auth-audit-card")?.textContent).toContain(authText("en", "paperTrade"));

    const inputs = container.querySelectorAll<HTMLInputElement>(".auth-audit-filters input");
    expect(inputs[0]?.maxLength).toBe(96);
    expect(inputs[1]?.maxLength).toBe(64);
    await change(inputs[0]!, "user.disabled");
    await change(inputs[1]!, ROMAN_ID);
    await act(async () => inputs[0]!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(requests.some((url) => url.searchParams.get("eventType") === "user.disabled" && url.searchParams.get("subjectUserId") === ROMAN_ID)).toBe(true));
    await act(async () => root.unmount());
  });
});

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
