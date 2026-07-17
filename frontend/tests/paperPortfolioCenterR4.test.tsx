// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperPortfolioCenter } from "../src/trading/components/paper-portfolio/PaperPortfolioCenter";
import type { PaperPortfolioCenterClient } from "../src/trading/usePaperPortfolioCenter";
import { detailResponse, listResponse, ownerUserId } from "./paperPortfolioFixture";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "matchMedia");
});

describe("R4 paper portfolio center", () => {
  it("renders a semantic desktop table, server asOf and honest unavailable evidence", async () => {
    mockMedia(false);
    const client = clientStub();
    const { host, root } = await renderCenter(client);

    expect(host.querySelector(".paper-robot-table")).not.toBeNull();
    expect(host.querySelectorAll(".paper-robot-cards li")).toHaveLength(1);
    expect(host.textContent).toContain("Server snapshot");
    expect(host.textContent).toContain("10,020");

    const trigger = host.querySelector<HTMLButtonElement>(".paper-robot-open")!;
    trigger.focus();
    await click(trigger);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain("Paper margin model is not available");
    expect(host.textContent).toContain("Paper borrowing model is not available");
    await click(host.querySelector<HTMLButtonElement>(".paper-close-button")!);
    expect(document.activeElement).toBe(trigger);
    await act(async () => root.unmount());
  });

  it("is card-first with a collapsed sticky summary on mobile", async () => {
    mockMedia(true);
    const { host, root } = await renderCenter(clientStub());

    expect(host.querySelector(".paper-portfolio-summary.collapsed")).not.toBeNull();
    expect(host.querySelectorAll(".paper-robot-cards .paper-robot-card")).toHaveLength(1);
    expect(host.querySelector(".paper-robot-table")).not.toBeNull();
    expect(host.querySelectorAll(".paper-robot-actions button")[0]?.textContent).toContain("Pause");
    await act(async () => root.unmount());
  });

  it("requires confirmation and protects a rapid robot action from duplication", async () => {
    mockMedia(true);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const client = clientStub();
    vi.mocked(client.robotAction).mockImplementation(async () => {
      await pending;
      return detailResponse;
    });
    const { host, root } = await renderCenter(client);
    const pause = [...host.querySelectorAll<HTMLButtonElement>(".paper-robot-cards .paper-robot-actions button")].find((button) => button.textContent?.includes("Pause"))!;

    await click(pause);
    const dialog = host.querySelector<HTMLElement>('.paper-dialog[role="dialog"]')!;
    expect(dialog.textContent).toContain("Confirm robot action");
    const confirm = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      confirm.click();
      confirm.click();
      await Promise.resolve();
    });
    expect(client.robotAction).toHaveBeenCalledOnce();
    expect(client.robotAction).toHaveBeenCalledWith(ownerUserId, "portfolio-1", "bot-1", {
      action: "pause",
      expectedPortfolioRevision: 4,
      expectedLedgerEpoch: 1,
      expectedBotRevision: 3
    }, expect.objectContaining({ idempotencyKey: "idempotency-test" }));

    await act(async () => { release?.(); await pending; await Promise.resolve(); });
    await act(async () => root.unmount());
  });

  it("creates the first portfolio with canonical money and confirms archive by exact name", async () => {
    mockMedia(false);
    const emptyClient = clientStub();
    vi.mocked(emptyClient.list).mockResolvedValue({ ...listResponse, portfolios: [] });
    const empty = await renderCenter(emptyClient);
    await click(empty.host.querySelector<HTMLButtonElement>(".paper-center-empty button")!);
    const createInputs = empty.host.querySelectorAll<HTMLInputElement>(".paper-dialog input");
    await changeInput(createInputs[0], "Research");
    await changeInput(createInputs[1], "2500,5");
    await submit(empty.host.querySelector<HTMLFormElement>(".paper-dialog form")!);
    expect(emptyClient.create).toHaveBeenCalledWith(ownerUserId, { name: "Research", initialCapital: "2500.500000" }, expect.objectContaining({ idempotencyKey: "idempotency-test" }));
    await act(async () => empty.root.unmount());

    const client = clientStub();
    const populated = await renderCenter(client);
    const archive = [...populated.host.querySelectorAll<HTMLButtonElement>(".paper-portfolio-menu button")].find((button) => button.textContent?.includes("Archive"))!;
    await click(archive);
    await changeInput(populated.host.querySelector<HTMLInputElement>(".paper-dialog input")!, "Main paper");
    await submit(populated.host.querySelector<HTMLFormElement>(".paper-dialog form")!);
    expect(client.archive).toHaveBeenCalledWith(ownerUserId, "portfolio-1", {
      expectedPortfolioRevision: 4,
      expectedLedgerEpoch: 1,
      confirmName: "Main paper"
    }, expect.objectContaining({ idempotencyKey: "idempotency-test" }));
    await act(async () => populated.root.unmount());
  });
});

async function renderCenter(client: PaperPortfolioCenterClient) {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PaperPortfolioCenter ownerUserId={ownerUserId} locale="en" canMutate onNewRobot={() => {}} client={client} refreshIntervalMs={3_600_000} />));
  return { host, root };
}

function clientStub(): PaperPortfolioCenterClient {
  return {
    list: vi.fn(async () => listResponse),
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

function mockMedia(matches: boolean): void {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }))
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.click(); await Promise.resolve(); });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
}
