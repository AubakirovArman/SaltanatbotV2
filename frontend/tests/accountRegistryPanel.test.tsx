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
  status: "credentials_missing",
  credential: { mode: "account_isolated", status: "missing", isolated: true },
  capabilities: { liveExecution: false, credentialIsolation: true, multipleCredentialAccounts: true },
  botIds: []
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("per-user trading account registry", () => {
  it("renders the account-isolation boundary and complete EN/RU/KK copy", async () => {
    for (const locale of ["en", "ru", "kk"] as const) {
      expect(accountRegistryText(locale, "title")).toBeTruthy();
      expect(accountRegistryText(locale, "boundary")).toMatch(/credentials|ключ|Кілт/i);
      expect(accountRegistryText(locale, "credentialsHint")).toBeTruthy();
    }

    const { container, root } = await render({ locale: "ru", loadAccounts: async () => [desk] });
    expect(container.querySelector("section")?.getAttribute("aria-labelledby")).toBe("account-registry-title");
    expect(container.querySelector('[role="note"]')?.textContent).toContain("собственные зашифрованные ключи");
    expect(container.textContent).toContain("Ключи не настроены");
    expect(container.textContent).toContain("Под управлением");
    expect([...container.querySelectorAll("legend")].map((item) => item.textContent)).toEqual(expect.arrayContaining(["Биржа", "Принадлежность"]));
    const credentialForm = container.querySelector<HTMLFormElement>(".account-credential-form")!;
    expect(credentialForm.getAttribute("autocomplete")).toBe("off");
    expect([...credentialForm.querySelectorAll("input")].every((input) => input.getAttribute("autocomplete") === "off" && input.type === "password")).toBe(true);
    expect([...credentialForm.querySelectorAll("label")].every((label) => !!label.htmlFor && document.getElementById(label.htmlFor) instanceof HTMLInputElement)).toBe(true);
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
        status: input.enabled === false ? "disabled" : input.enabled === true && current.status === "disabled" ? (current.credential.status === "configured" ? "ready" : "credentials_missing") : current.status,
        capabilities: { ...current.capabilities, liveExecution: input.enabled === false ? false : current.credential.status === "configured" }
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
    expect(container.textContent).toContain("Trading account added.");
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
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("Delete this trading account?"));
    expect(removeAccount).toHaveBeenCalledWith("desk");
    expect(container.textContent).not.toContain("Desk renamed");
    expect(container.textContent).toContain("Trading account deleted.");
    await act(async () => root.unmount());
  });

  it("sets, rotates and removes credentials inside the owning account card without reading them back", async () => {
    const configured: TradingAccountView = {
      ...desk,
      updatedAt: 3,
      status: "ready",
      credential: { ...desk.credential, status: "configured" },
      capabilities: { ...desk.capabilities, liveExecution: true }
    };
    const cleared: TradingAccountView = {
      ...configured,
      updatedAt: 4,
      status: "credentials_missing",
      credential: { ...configured.credential, status: "missing" },
      capabilities: { ...configured.capabilities, liveExecution: false }
    };
    const saveCredentials = vi.fn(async () => configured);
    const clearCredentials = vi.fn(async () => cleared);
    const confirmAction = vi.fn(() => true);
    const { container, root } = await render({ locale: "en", loadAccounts: async () => [desk], saveCredentials, clearCredentials, confirmAction });
    const card = cardFor(container, "Desk account");
    const credentialForm = card.querySelector<HTMLFormElement>(".account-credential-form")!;
    const apiKey = credentialForm.querySelector<HTMLInputElement>('input[name="apiKey"]')!;
    const apiSecret = credentialForm.querySelector<HTMLInputElement>('input[name="apiSecret"]')!;

    await changeInput(apiKey, "account-key-123");
    await changeInput(apiSecret, "account-secret-123");
    await submit(credentialForm);
    expect(saveCredentials).toHaveBeenCalledWith("desk", { apiKey: "account-key-123", apiSecret: "account-secret-123" });
    expect(apiKey.value).toBe("");
    expect(apiSecret.value).toBe("");
    expect(container.textContent).toContain("Account credentials saved.");
    expect(container.textContent).not.toContain("account-key-123");
    expect(container.textContent).not.toContain("account-secret-123");

    await changeInput(apiKey, "rotated-key-123");
    await changeInput(apiSecret, "rotated-secret-123");
    await submit(credentialForm);
    expect(saveCredentials).toHaveBeenLastCalledWith("desk", { apiKey: "rotated-key-123", apiSecret: "rotated-secret-123" });
    expect(container.textContent).toContain("Account credentials rotated.");

    const configuredCard = cardFor(container, "Desk account");
    await click(buttonFor(configuredCard, "Remove credentials"));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining("Remove this account's exchange credentials?"));
    expect(clearCredentials).toHaveBeenCalledWith("desk");
    expect(container.textContent).toContain("Account credentials removed.");
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
