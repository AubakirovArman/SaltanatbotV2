// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paperPortfolioText } from "../src/i18n/paperPortfolio";
import { starterStrategyXml } from "../src/strategy/starter";
import type { StrategyArtifact } from "../src/strategy/library";
import { CreateBotForm } from "../src/trading/components/CreateBotForm";
import type { PaperPortfolioDetail, PaperPortfolioListResponse, PaperPortfolioMetadata } from "../src/trading/paperPortfolioTypes";
import type { SaveBotInput, SaveBotOptions, TradingBot } from "../src/trading/tradeClient";
import { detailResponse, listResponse, money, ownerUserId, portfolio } from "./paperPortfolioFixture";

const strategy: StrategyArtifact = {
  id: "strategy:paper-binding",
  kind: "strategy",
  name: "Paper binding strategy",
  description: "Test strategy",
  xml: starterStrategyXml,
  createdAt: 1,
  updatedAt: 1
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("database-auth paper bot binding", () => {
  it("selects the active default portfolio and sends exact allocation, revision fences and owner-scoped idempotency options", async () => {
    const secondary = metadata({ id: "portfolio-secondary", name: "Secondary", isDefault: false, revision: 3, currentEpoch: 2 });
    const archived = metadata({ id: "portfolio-archived", name: "Archived", status: "archived", isDefault: false, archivedAt: 1_721_000_000_000 });
    const preferred = metadata({ id: "portfolio-default", name: "Default funded", isDefault: true, revision: 12, currentEpoch: 6 });
    const list = portfolioList([secondary, archived, preferred]);
    const detail = portfolioDetail(preferred, "20000.000000", 7);
    const loadPaperPortfolios = vi.fn(async () => list);
    const loadPaperPortfolio = vi.fn(async () => detail);
    const saveTradingBot = saveSpy();
    const { container, root } = await render({ ownerUserId, loadPaperPortfolios, loadPaperPortfolio, saveTradingBot });

    await waitFor(() => container.querySelector<HTMLSelectElement>('select[name="paper-portfolio-id"]')?.value === preferred.id, "default paper portfolio selection");

    const portfolioSelect = container.querySelector<HTMLSelectElement>('select[name="paper-portfolio-id"]')!;
    const allocation = container.querySelector<HTMLInputElement>('input[name="paper-allocation"]')!;
    const submitButton = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect([...portfolioSelect.options].map((option) => option.value)).toEqual([secondary.id, preferred.id]);
    expect([...portfolioSelect.options].map((option) => option.value)).not.toContain(archived.id);
    expect(allocation.value).toBe("10000.000000");
    expect(submitButton.disabled).toBe(false);
    expect(loadPaperPortfolios).toHaveBeenCalledWith(ownerUserId, expect.any(AbortSignal));
    expect(loadPaperPortfolio).toHaveBeenCalledWith(ownerUserId, preferred.id, expect.any(AbortSignal));

    await submit(container.querySelector<HTMLFormElement>("form")!);
    await waitFor(() => saveTradingBot.mock.calls.length === 1, "paper bot creation");

    const [body, options] = saveTradingBot.mock.calls[0]!;
    expect(body).toEqual(expect.objectContaining({
      exchange: "paper",
      paperPortfolioId: preferred.id,
      paperAllocation: "10000.000000",
      expectedPortfolioRevision: 12,
      expectedLedgerEpoch: 7
    }));
    expect(options).toEqual({ ownerUserId, idempotencyKey: expect.any(String) });
    expect(options?.idempotencyKey).toMatch(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    await act(async () => root.unmount());
  });

  it("canonicalizes a comma decimal before sending the reservation command", async () => {
    const preferred = metadata({ id: "portfolio-comma", name: "Comma funded", isDefault: true, revision: 8, currentEpoch: 3 });
    const saveTradingBot = saveSpy();
    const { container, root } = await render({
      ownerUserId,
      loadPaperPortfolios: async () => portfolioList([preferred]),
      loadPaperPortfolio: async () => portfolioDetail(preferred, "20000.000000", 4),
      saveTradingBot
    });
    await waitFor(() => !container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, "funded portfolio binding");

    await changeInput(container.querySelector<HTMLInputElement>('input[name="paper-allocation"]')!, "2500,5");
    await submit(container.querySelector<HTMLFormElement>("form")!);
    await waitFor(() => saveTradingBot.mock.calls.length === 1, "canonical paper allocation submission");

    expect(saveTradingBot.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      paperPortfolioId: preferred.id,
      paperAllocation: "2500.500000",
      expectedPortfolioRevision: 8,
      expectedLedgerEpoch: 4
    }));
    await act(async () => root.unmount());
  });

  it("fails closed when the requested allocation exceeds exact available capital", async () => {
    const saveTradingBot = saveSpy();
    const { container, root } = await render({
      ownerUserId,
      locale: "ru",
      loadPaperPortfolios: async () => listResponse,
      loadPaperPortfolio: async () => detailResponse,
      saveTradingBot
    });
    await waitFor(() => container.textContent?.includes(paperPortfolioText("ru", "insufficientCapital")) ?? false, "insufficient-capital validation");

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[name="paper-allocation"]')?.getAttribute("aria-invalid")).toBe("true");
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(saveTradingBot).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("shows the canonical Portfolio Center CTA and remains disabled when no active portfolio exists", async () => {
    const archived = metadata({ id: "portfolio-archived", status: "archived", isDefault: false, archivedAt: 1_721_000_000_000 });
    const onOpenPortfolioCenter = vi.fn();
    const loadPaperPortfolio = vi.fn(async () => portfolioDetail(archived, "20000.000000"));
    const saveTradingBot = saveSpy();
    const { container, root } = await render({
      ownerUserId,
      locale: "kk",
      onOpenPortfolioCenter,
      loadPaperPortfolios: async () => portfolioList([archived]),
      loadPaperPortfolio,
      saveTradingBot
    });
    await waitFor(() => findButton(container, paperPortfolioText("kk", "openPortfolioCenter")) !== undefined, "Portfolio Center CTA");

    expect(container.textContent).toContain(paperPortfolioText("kk", "noActivePortfolio"));
    expect(container.querySelector<HTMLSelectElement>('select[name="paper-portfolio-id"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(loadPaperPortfolio).not.toHaveBeenCalled();
    await click(findButton(container, paperPortfolioText("kk", "openPortfolioCenter"))!);
    expect(onOpenPortfolioCenter).toHaveBeenCalledOnce();
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(saveTradingBot).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("forbids a portfolio archived between list and detail reads", async () => {
    const listedActive = metadata({ id: "portfolio-race", name: "Archiving", isDefault: true });
    const archivedDetail = metadata({ ...listedActive, status: "archived", archivedAt: 1_721_000_000_000 });
    const saveTradingBot = saveSpy();
    const { container, root } = await render({
      ownerUserId,
      locale: "ru",
      loadPaperPortfolios: async () => portfolioList([listedActive]),
      loadPaperPortfolio: async () => portfolioDetail(archivedDetail, "20000.000000"),
      saveTradingBot
    });
    await waitFor(
      () => container.textContent?.includes(paperPortfolioText("ru", "archivedPortfolioForbidden")) ?? false,
      "archived portfolio rejection"
    );

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(saveTradingBot).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("fails closed when portfolio discovery fails", async () => {
    const loadPaperPortfolio = vi.fn(async () => detailResponse);
    const saveTradingBot = saveSpy();
    const { container, root } = await render({
      ownerUserId,
      loadPaperPortfolios: async () => { throw new Error("offline"); },
      loadPaperPortfolio,
      saveTradingBot
    });
    await waitFor(() => container.textContent?.includes(paperPortfolioText("en", "bindingLoadFailed")) ?? false, "portfolio load failure");

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(loadPaperPortfolio).not.toHaveBeenCalled();
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(saveTradingBot).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("remains fail-closed while a database session has no resolved owner identity", async () => {
    const loadPaperPortfolios = vi.fn(async () => listResponse);
    const saveTradingBot = saveSpy();
    const { container, root } = await render({
      paperPortfolioBindingRequired: true,
      loadPaperPortfolios,
      saveTradingBot
    });

    expect(container.textContent).toContain(paperPortfolioText("en", "noActivePortfolio"));
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(loadPaperPortfolios).not.toHaveBeenCalled();
    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(saveTradingBot).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("keeps the legacy paper flow unchanged without owner headers or durable binding fields", async () => {
    const loadPaperPortfolios = vi.fn(async () => listResponse);
    const loadPaperPortfolio = vi.fn(async () => detailResponse);
    const saveTradingBot = saveSpy();
    const { container, root } = await render({ loadPaperPortfolios, loadPaperPortfolio, saveTradingBot });

    expect(loadPaperPortfolios).not.toHaveBeenCalled();
    expect(loadPaperPortfolio).not.toHaveBeenCalled();
    expect(container.querySelector('select[name="paper-portfolio-id"]')).toBeNull();
    expect(container.querySelector('input[name="paper-allocation"]')).toBeNull();
    await submit(container.querySelector<HTMLFormElement>("form")!);
    await waitFor(() => saveTradingBot.mock.calls.length === 1, "legacy bot creation");

    const [body, options] = saveTradingBot.mock.calls[0]!;
    expect(saveTradingBot.mock.calls[0]).toHaveLength(1);
    expect(body).not.toHaveProperty("paperPortfolioId");
    expect(body).not.toHaveProperty("paperAllocation");
    expect(body).not.toHaveProperty("expectedPortfolioRevision");
    expect(body).not.toHaveProperty("expectedLedgerEpoch");
    expect(options).toBeUndefined();
    await act(async () => root.unmount());
  });
});

async function render(props: Partial<ComponentProps<typeof CreateBotForm>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CreateBotForm strategies={[strategy]} locale="en" onCreated={() => {}} {...props} />);
    await Promise.resolve();
  });
  return { container, root };
}

function metadata(overrides: Partial<PaperPortfolioMetadata>): PaperPortfolioMetadata {
  return { ...portfolio, ...overrides };
}

function portfolioList(portfolios: PaperPortfolioMetadata[]): PaperPortfolioListResponse {
  return { ...listResponse, portfolios };
}

function portfolioDetail(selected: PaperPortfolioMetadata, availableCapital: string, ledgerEpoch = selected.currentEpoch): PaperPortfolioDetail {
  return {
    ...detailResponse,
    portfolio: selected,
    snapshot: {
      ...detailResponse.snapshot,
      ownerUserId: selected.ownerUserId,
      portfolioId: selected.id,
      ledgerEpoch,
      aggregates: { ...detailResponse.snapshot.aggregates, availableCapital: money(availableCapital) }
    }
  };
}

function saveSpy() {
  return vi.fn(async (input: SaveBotInput, _options?: SaveBotOptions) => savedBot(input));
}

function savedBot(input: SaveBotInput): TradingBot {
  return { ...input, id: "bot-created", status: "stopped", createdAt: 1, updatedAt: 1 } as TradingBot;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
