// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperPortfolioCenterClient, PaperPortfolioCenterState } from "../src/trading/usePaperPortfolioCenter";
import { usePaperPortfolioCenter } from "../src/trading/usePaperPortfolioCenter";
import { detailResponse, listResponse, ownerUserId } from "./paperPortfolioFixture";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let state: PaperPortfolioCenterState | undefined;

afterEach(() => {
  state = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("usePaperPortfolioCenter", () => {
  it("fails closed immediately when the authenticated owner changes", async () => {
    const client = clientStub();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness owner={ownerUserId} client={client} />));
    expect(host.textContent).toContain("Main paper");

    await act(async () => root.render(<Harness owner="owner-b" client={client} />));
    expect(host.textContent).not.toContain("Main paper");
    expect(client.list).toHaveBeenCalledWith("owner-b", expect.any(AbortSignal));
    await act(async () => root.unmount());
  });

  it("retains last-good evidence but marks it stale after a refresh failure", async () => {
    const client = clientStub();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness owner={ownerUserId} client={client} />));
    vi.mocked(client.list).mockRejectedValueOnce(new Error("offline"));

    await act(async () => { await state?.refresh(); });

    expect(state?.detail?.portfolio.name).toBe("Main paper");
    expect(state?.stale).toBe(true);
    expect(state?.error?.message).toBe("offline");
    await act(async () => root.unmount());
  });

  it("serializes rapid duplicate robot actions into one mutation", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const client = clientStub();
    vi.mocked(client.robotAction).mockImplementation(async () => {
      await pending;
      return detailResponse;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness owner={ownerUserId} client={client} />));
    const robot = state!.detail!.snapshot.robots[0];

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = state!.runRobotAction(robot, "pause");
      second = state!.runRobotAction(robot, "pause");
    });
    expect(client.robotAction).toHaveBeenCalledOnce();
    expect(first).toBe(second);

    await act(async () => {
      release?.();
      await Promise.all([first, second]);
    });
    expect(client.robotAction).toHaveBeenCalledWith(ownerUserId, "portfolio-1", "bot-1", {
      action: "pause",
      expectedPortfolioRevision: 4,
      expectedLedgerEpoch: 1,
      expectedBotRevision: 3
    }, expect.objectContaining({ idempotencyKey: "idempotency-test" }));
    await act(async () => root.unmount());
  });

  it("keeps a newly created portfolio selected while refreshing the list", async () => {
    const created = {
      ...detailResponse,
      portfolio: { ...detailResponse.portfolio, id: "portfolio-2", name: "Second paper", isDefault: false },
      snapshot: { ...detailResponse.snapshot, portfolioId: "portfolio-2" }
    };
    const client = clientStub();
    vi.mocked(client.create).mockResolvedValue(created);
    vi.mocked(client.list)
      .mockResolvedValueOnce(listResponse)
      .mockResolvedValueOnce({
        ...listResponse,
        portfolios: [...listResponse.portfolios, created.portfolio]
      });
    vi.mocked(client.get).mockImplementation(async (_owner, portfolioId) => (
      portfolioId === created.portfolio.id ? created : detailResponse
    ));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness owner={ownerUserId} client={client} />));

    await act(async () => {
      await state!.createPortfolio("Second paper", "10000.000000");
    });

    expect(client.get).toHaveBeenLastCalledWith(ownerUserId, "portfolio-2", expect.any(AbortSignal));
    expect(state?.selectedPortfolioId).toBe("portfolio-2");
    expect(state?.detail?.portfolio.name).toBe("Second paper");
    await act(async () => root.unmount());
  });
});

function Harness({ owner, client }: { owner: string; client: PaperPortfolioCenterClient }) {
  state = usePaperPortfolioCenter({ ownerUserId: owner, client, refreshIntervalMs: 3_600_000 });
  return <div>{state.detail?.portfolio.name ?? "none"}</div>;
}

function clientStub(): PaperPortfolioCenterClient {
  return {
    list: vi.fn(async (owner) => owner === ownerUserId ? listResponse : { ...listResponse, portfolios: [], asOf: listResponse.asOf + 1 }),
    get: vi.fn(async () => detailResponse),
    create: vi.fn(async () => detailResponse),
    rename: vi.fn(async () => detailResponse),
    setDefault: vi.fn(async () => detailResponse),
    archive: vi.fn(async () => detailResponse),
    reset: vi.fn(async () => detailResponse),
    robotAction: vi.fn(async () => detailResponse),
    idempotencyKey: () => "idempotency-test"
  };
}
