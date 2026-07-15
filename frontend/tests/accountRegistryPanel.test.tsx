// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountRegistryText } from "../src/trading/accountRegistryText";
import type { TradingAccountView } from "../src/trading/accountClient";
import { AccountRegistryPanel } from "../src/trading/components/AccountRegistryPanel";

const desk: TradingAccountView = {
  id: "desk",
  label: "Desk account",
  exchange: "bybit",
  ownership: "managed",
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  status: "metadata_only",
  credential: { mode: "unsupported", status: "unsupported", isolated: false },
  capabilities: { liveExecution: false, credentialIsolation: false, multipleCredentialAccounts: false },
  botIds: []
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("admin trading account registry", () => {
  it("renders the honest capability boundary and complete EN/RU/KK copy", async () => {
    for (const locale of ["en", "ru", "kk"] as const) {
      expect(accountRegistryText(locale, "title")).toBeTruthy();
      expect(accountRegistryText(locale, "metadataOnly")).toBeTruthy();
      expect(accountRegistryText(locale, "boundary")).toMatch(/credentials|ключ|Кілт/i);
    }

    const { container, root } = await render({ locale: "ru", loadAccounts: async () => [desk] });
    expect(container.querySelector("section")?.getAttribute("aria-labelledby")).toBe("account-registry-title");
    expect(container.querySelector('[role="note"]')?.textContent).toContain("Новые записи работают только как метаданные");
    expect(container.textContent).toContain("марже и заимствованиях");
    expect(container.textContent).toContain("Только метаданные");
    expect(container.textContent).toContain("Под управлением");
    expect([...container.querySelectorAll("legend")].map((item) => item.textContent)).toEqual(expect.arrayContaining(["Биржа", "Принадлежность"]));
    await act(async () => root.unmount());
  });

  it("creates, edits, disables and deletes account metadata with confirmations", async () => {
    const records = new Map([[desk.id, desk]]);
    const created: TradingAccountView = { ...desk, id: "new", label: "New account", ownership: "own" };
    const createAccount = vi.fn(async () => {
      records.set(created.id, created);
      return created;
    });
    const updateAccount = vi.fn(async (id: string, input: Partial<TradingAccountView>) => {
      const current = records.get(id)!;
      const next: TradingAccountView = {
        ...current,
        ...input,
        updatedAt: current.updatedAt + 1,
        status: input.enabled === false ? "disabled" : input.enabled === true && current.status === "disabled" ? "metadata_only" : current.status
      };
      records.set(id, next);
      return next;
    });
    const removeAccount = vi.fn(async (id: string) => {
      records.delete(id);
    });
    const confirmAction = vi.fn(() => true);
    const { container, root } = await render({
      locale: "en",
      loadAccounts: async () => [desk],
      createAccount,
      updateAccount,
      removeAccount,
      confirmAction
    });

    const createLabel = container.querySelector<HTMLInputElement>('input[name="account-label"]')!;
    await changeInput(createLabel, "New account");
    await submit(container.querySelector<HTMLFormElement>(".account-registry-form")!);
    expect(createAccount).toHaveBeenCalledWith({ label: "New account", exchange: "bybit", ownership: "own", enabled: true });
    expect(container.textContent).toContain("Account metadata added.");
    expect(container.textContent).toContain("New account");

    let deskCard = cardFor(container, "Desk account");
    await click(buttonFor(deskCard, "Edit"));
    const editLabel = deskCard.querySelector<HTMLInputElement>('input[name^="account-label-"]')!;
    await changeInput(editLabel, "Desk renamed");
    await click(buttonFor(deskCard, "Save changes"));
    expect(updateAccount).toHaveBeenCalledWith("desk", { label: "Desk renamed", ownership: "managed" });

    deskCard = cardFor(container, "Desk renamed");
    await click(buttonFor(deskCard, "Disable"));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("Disable this account?"));
    expect(container.textContent).toContain("Account disabled.");

    deskCard = cardFor(container, "Desk renamed");
    await click(buttonFor(deskCard, "Delete"));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("Delete this account metadata?"));
    expect(removeAccount).toHaveBeenCalledWith("desk");
    expect(container.textContent).not.toContain("Desk renamed");
    expect(container.textContent).toContain("Account metadata deleted.");
    await act(async () => root.unmount());
  });

  it("blocks mutations on insecure origins and accounts with bound robots", async () => {
    const inUse = { ...desk, botIds: ["robot-1"] };
    const { container, root } = await render({ locale: "kk", secureTradingOrigin: false, loadAccounts: async () => [inUse] });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("HTTPS");
    expect(buttonFor(cardFor(container, "Desk account"), "Өшіру").disabled).toBe(true);
    expect(buttonFor(cardFor(container, "Desk account"), "Жою").disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.account-registry-form button[type="submit"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("роботтар байланған");
    await act(async () => root.unmount());
  });
});

async function render(props: Partial<ComponentProps<typeof AccountRegistryPanel>> & Pick<ComponentProps<typeof AccountRegistryPanel>, "locale" | "loadAccounts">) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AccountRegistryPanel secureTradingOrigin {...props} />);
    await Promise.resolve();
  });
  return { container, root };
}

function cardFor(container: HTMLElement, title: string): HTMLElement {
  const heading = [...container.querySelectorAll("h3")].find((item) => item.textContent === title);
  const card = heading?.closest<HTMLElement>("article");
  if (!card) throw new Error(`Missing account card: ${title}`);
  return card;
}

function buttonFor(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
