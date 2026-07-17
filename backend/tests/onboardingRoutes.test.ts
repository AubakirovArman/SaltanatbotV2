import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { configureIdentityAuth, requireAppAuth } from "../src/auth.js";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { IdentityService } from "../src/identity/service.js";
import {
  OnboardingAuthorizationChangedError,
  OnboardingConflictError
} from "../src/onboarding/errors.js";
import {
  createOnboardingRouter,
  ONBOARDING_REQUEST_BODY_BYTE_LIMIT
} from "../src/onboarding/routes.js";
import type { OnboardingRepositoryContract } from "../src/onboarding/repository.js";
import {
  emptyOnboardingState,
  type OnboardingState
} from "../src/onboarding/types.js";

const OWNER_A = "00000000-0000-4000-8000-000000000041";
const OWNER_B = "00000000-0000-4000-8000-000000000042";
let server: Server;
let baseUrl: string;

const repository: OnboardingRepositoryContract = {
  get: vi.fn(async () => emptyOnboardingState()),
  selectGoal: vi.fn(async (_owner, _revision, goal) => ({
    ...emptyOnboardingState(),
    revision: 1,
    status: "in_progress",
    goal,
    goalSelectedAt: "2026-07-16T00:00:00.000Z",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z"
  })),
  recordMilestone: vi.fn(async () => emptyOnboardingState()),
  dismiss: vi.fn(async () => emptyOnboardingState()),
  restart: vi.fn(async () => emptyOnboardingState())
};

describe("onboarding API route contract", () => {
  beforeAll(async () => {
    const app = express();
    app.use((request, response, next) => {
      response.locals.authMode =
        request.header("x-test-auth-mode") ?? "database";
      response.locals.authPrincipal = {
        user: {
          id: request.header("x-test-owner"),
          authorizationRevision: Number(
            request.header("x-test-authorization-revision") ?? 1
          )
        }
      };
      next();
    });
    app.use(
      "/api/onboarding",
      createOnboardingRouter({} as Pool, { repository })
    );
    app.use(
      (
        _error: unknown,
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction
      ) => {
        response.status(500).json({ code: "internal_error" });
      }
    );
    ({ server, baseUrl } = await startServer(app));
  });

  beforeEach(() => {
    for (const method of Object.values(repository)) {
      vi.mocked(method).mockClear();
    }
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("requires the exact authenticated owner and never touches the repository on mismatch", async () => {
    for (const expectedOwner of [undefined, OWNER_A]) {
      const response = await request("/", {
        owner: OWNER_B,
        expectedOwner
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "onboarding_owner_mismatch"
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(repository.get).not.toHaveBeenCalled();
  });

  it("returns a no-store virtual first-run state without creating data", async () => {
    const response = await request("", {
      owner: OWNER_B,
      expectedOwner: OWNER_B
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      onboarding: emptyOnboardingState()
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(repository.get).toHaveBeenCalledWith(OWNER_B);
  });

  it("accepts only strict bounded goal and milestone shapes", async () => {
    for (const [path, method, body] of [
      ["/goal", "PUT", { revision: 0, goal: "live-trade" }],
      ["/goal", "PUT", { revision: -1, goal: "monitoring" }],
      [
        "/goal",
        "PUT",
        { revision: 0, goal: "monitoring", apiKey: "must-never-be-accepted" }
      ],
      [
        "/milestones",
        "POST",
        { revision: 0, milestone: "private-order-submitted" }
      ],
      ["/dismiss", "POST", { revision: 0, extra: true }]
    ] as const) {
      const response = await request(path, {
        owner: OWNER_B,
        expectedOwner: OWNER_B,
        method,
        body
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(repository.selectGoal).not.toHaveBeenCalled();
    expect(repository.recordMilestone).not.toHaveBeenCalled();
    expect(repository.dismiss).not.toHaveBeenCalled();
  });

  it("returns stable no-store errors for malformed and oversized JSON", async () => {
    const malformed = await fetch(`${baseUrl}/goal`, {
      method: "PUT",
      headers: headers(OWNER_B, OWNER_B),
      body: '{"revision":'
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Onboarding request body is not valid JSON.",
      code: "invalid_json"
    });
    expect(malformed.headers.get("Cache-Control")).toBe("no-store");

    const oversized = await request("/goal", {
      owner: OWNER_B,
      expectedOwner: OWNER_B,
      method: "PUT",
      body: { padding: "x".repeat(ONBOARDING_REQUEST_BODY_BYTE_LIMIT) }
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: `Onboarding request body exceeds ${ONBOARDING_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "onboarding_envelope_too_large"
    });
    expect(oversized.headers.get("Cache-Control")).toBe("no-store");
  });

  it("maps optimistic conflicts and authorization fences to stable 409 responses", async () => {
    const current: OnboardingState = {
      ...emptyOnboardingState(),
      revision: 2,
      status: "in_progress",
      goal: "monitoring",
      goalSelectedAt: "2026-07-16T00:00:00.000Z",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z"
    };
    vi.mocked(repository.selectGoal).mockRejectedValueOnce(
      new OnboardingConflictError(current)
    );
    const conflict = await request("/goal", {
      owner: OWNER_B,
      expectedOwner: OWNER_B,
      method: "PUT",
      body: { revision: 1, goal: "backtest" }
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "onboarding_conflict",
      current
    });

    vi.mocked(repository.selectGoal).mockRejectedValueOnce(
      new OnboardingAuthorizationChangedError()
    );
    const stale = await request("/goal", {
      owner: OWNER_B,
      expectedOwner: OWNER_B,
      method: "PUT",
      body: { revision: 1, goal: "backtest" }
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "Onboarding authorization changed. Reload before retrying.",
      code: "onboarding_authorization_changed"
    });
    expect(stale.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("onboarding authentication and CSRF boundary", () => {
  afterEach(() => {
    configureIdentityAuth(undefined);
  });

  it("is unavailable without a session and requires CSRF for mutations", async () => {
    const identity = new IdentityService(new MemoryIdentityRepository());
    const temporaryPassword = "temporary-Admin-password-2026";
    const permanentPassword = "permanent-Admin-password-2026";
    await identity.bootstrapAdmin("onboarding-admin", temporaryPassword);
    const temporarySession = await identity.login(
      "onboarding-admin",
      temporaryPassword
    );
    const temporaryPrincipal = await identity.authenticate(
      temporarySession.sessionToken
    );
    await identity.changePassword(
      temporaryPrincipal!,
      temporaryPassword,
      permanentPassword
    );
    const session = await identity.login("onboarding-admin", permanentPassword);
    configureIdentityAuth(identity);

    const app = express();
    app.use("/api", requireAppAuth);
    app.use(
      "/api/onboarding",
      createOnboardingRouter({} as Pool, { repository })
    );
    const running = await startServer(app);
    try {
      expect(
        (await fetch(`${running.baseUrl}/`, { headers: { accept: "application/json" } }))
          .status
      ).toBe(401);

      const cookie = `sbv2_session=${encodeURIComponent(session.sessionToken)}`;
      const withoutCsrf = await fetch(`${running.baseUrl}/goal`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-sbv2-expected-user": session.user.id
        },
        body: JSON.stringify({ revision: 0, goal: "monitoring" })
      });
      expect(withoutCsrf.status).toBe(403);
      expect(await withoutCsrf.json()).toMatchObject({ code: "invalid_csrf" });

      const authorized = await fetch(`${running.baseUrl}/goal`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": session.csrfToken,
          "x-sbv2-expected-user": session.user.id
        },
        body: JSON.stringify({ revision: 0, goal: "monitoring" })
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toMatchObject({
        onboarding: { goal: "monitoring", revision: 1 }
      });
    } finally {
      await closeServer(running.server);
    }
  });
});

interface RequestInput {
  owner: string;
  expectedOwner?: string;
  method?: string;
  body?: unknown;
}

function request(path: string, input: RequestInput): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: input.method,
    headers: headers(input.owner, input.expectedOwner),
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });
}

function headers(
  owner: string,
  expectedOwner?: string
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-test-owner": owner,
    ...(expectedOwner
      ? { "x-sbv2-expected-user": expectedOwner }
      : {})
  };
}

async function startServer(
  app: express.Express
): Promise<{ server: Server; baseUrl: string }> {
  const running = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const port = (running.address() as { port: number }).port;
  return {
    server: running,
    baseUrl: `http://127.0.0.1:${port}/api/onboarding`
  };
}

function closeServer(instance: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    instance.close((error) => (error ? reject(error) : resolve()));
  });
}
