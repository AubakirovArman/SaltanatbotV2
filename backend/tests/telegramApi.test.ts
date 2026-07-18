import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MESSAGE_TEXT_LIMIT,
  TelegramApi,
  TelegramApiError,
  TelegramRateLimitError
} from "../src/notifications/telegramApi.js";

const TOKEN = "1234567890:AAtestSecretPartNeverLoggedAnywhere01";

describe("telegram api client", () => {
  it("posts JSON to the token-bearing URL and unwraps the ok envelope", async () => {
    const fetchImpl = okFetch({ id: 42, is_bot: true });
    const api = new TelegramApi(TOKEN, { fetchImpl });

    await expect(api.getMe()).resolves.toEqual({ id: 42, isBot: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
  });

  it("rejects a malformed getMe user without retrying", async () => {
    const api = new TelegramApi(TOKEN, { fetchImpl: okFetch({ id: "42" }) });
    await expect(api.getMe()).rejects.toMatchObject({ retryable: false });
  });

  it("sends plain text with no parse_mode and returns the message id receipt", async () => {
    const fetchImpl = okFetch({ message_id: 987 });
    const api = new TelegramApi(TOKEN, { fetchImpl });

    await expect(api.sendMessage("555", "BTC alert <b>&title</b>")).resolves.toEqual({ messageId: "987" });
    const payload = sentPayload(fetchImpl);
    expect(payload).toEqual({ chat_id: "555", text: "BTC alert <b>&title</b>", disable_web_page_preview: true });
    expect(payload).not.toHaveProperty("parse_mode");
  });

  it("bounds outgoing text at the telegram message limit with an ellipsis", async () => {
    const fetchImpl = okFetch({ message_id: 1 });
    const api = new TelegramApi(TOKEN, { fetchImpl });

    await api.sendMessage("555", "x".repeat(TELEGRAM_MESSAGE_TEXT_LIMIT + 500));
    const text = (sentPayload(fetchImpl) as { text: string }).text;
    expect(text).toHaveLength(TELEGRAM_MESSAGE_TEXT_LIMIT);
    expect(text.endsWith("…")).toBe(true);
  });

  it("long-polls getUpdates with the durable offset and message-only filter", async () => {
    const fetchImpl = okFetch([{ update_id: 7 }, { bogus: true }, { update_id: 2.5 }, null, { update_id: 8, message: { text: "/help" } }]);
    const api = new TelegramApi(TOKEN, { fetchImpl });

    const updates = await api.getUpdates(7);
    expect(updates.map((update) => update.update_id)).toEqual([7, 8]);
    expect(sentPayload(fetchImpl)).toEqual({ offset: 7, timeout: 25, allowed_updates: ["message"] });
  });

  it("treats a non-array getUpdates result as retryable", async () => {
    const api = new TelegramApi(TOKEN, { fetchImpl: okFetch({ not: "an array" }) });
    await expect(api.getUpdates(0)).rejects.toMatchObject({ retryable: true });
  });

  it("maps HTTP 429 to a typed rate-limit error honouring retry_after with a 15 minute cap", async () => {
    const limited = new TelegramApi(TOKEN, {
      fetchImpl: jsonFetch(429, { ok: false, parameters: { retry_after: 42 } })
    });
    await expect(limited.sendMessage("555", "hi")).rejects.toSatisfy(
      (error: unknown) => error instanceof TelegramRateLimitError && error.retryAfterMs === 42_000 && error.retryable
    );

    const capped = new TelegramApi(TOKEN, {
      fetchImpl: jsonFetch(429, { ok: false, parameters: { retry_after: 86_400 } })
    });
    await expect(capped.sendMessage("555", "hi")).rejects.toMatchObject({ retryAfterMs: 15 * 60_000 });

    const unspecified = new TelegramApi(TOKEN, { fetchImpl: jsonFetch(429, { ok: false }) });
    await expect(unspecified.sendMessage("555", "hi")).rejects.toMatchObject({ retryAfterMs: 5_000 });
  });

  it("marks 5xx retryable, 4xx and ok=false terminal", async () => {
    await expect(new TelegramApi(TOKEN, { fetchImpl: jsonFetch(502, {}) }).getMe()).rejects.toMatchObject({ retryable: true });
    await expect(new TelegramApi(TOKEN, { fetchImpl: jsonFetch(403, { ok: false }) }).getMe()).rejects.toMatchObject({ retryable: false });
    await expect(new TelegramApi(TOKEN, { fetchImpl: okFetch(undefined, { ok: false }) }).getMe()).rejects.toMatchObject({ retryable: false });
  });

  it("aborts a hung request after the configured timeout", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    const api = new TelegramApi(TOKEN, { fetchImpl, requestTimeoutMs: 25 });

    await expect(api.getMe()).rejects.toMatchObject({ retryable: true });
    await expect(api.getMe()).rejects.toThrow(/timeout/);
  });

  it("never places the token or URL into error messages", async () => {
    const leakyFailure = vi.fn(async () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
    }) as unknown as typeof fetch;

    const failures: unknown[] = [];
    await new TelegramApi(TOKEN, { fetchImpl: leakyFailure }).sendMessage("555", "hi").catch((error) => failures.push(error));
    await new TelegramApi(TOKEN, { fetchImpl: jsonFetch(500, {}) }).sendMessage("555", "hi").catch((error) => failures.push(error));
    await new TelegramApi(TOKEN, { fetchImpl: jsonFetch(429, { ok: false }) }).sendMessage("555", "hi").catch((error) => failures.push(error));

    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(TelegramApiError);
      const text = `${(failure as Error).message} ${(failure as Error).stack ?? ""}`;
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TOKEN.split(":")[1]);
      expect(text).not.toContain("api.telegram.org");
    }
  });

  it("bounds response reads at one MiB", async () => {
    const oversized = jsonBody(`{"ok":true,"result":{"padding":"${"y".repeat(1_100_000)}"}}`);
    await expect(new TelegramApi(TOKEN, { fetchImpl: oversized }).getMe()).rejects.toThrow(/exceeded/);
  });
});

function okFetch(result: unknown, envelope: Record<string, unknown> = { ok: true }): ReturnType<typeof vi.fn> & typeof fetch {
  return jsonFetch(200, { ...envelope, ...(envelope.ok === false ? {} : { result }) });
}

function jsonFetch(status: number, body: unknown): ReturnType<typeof vi.fn> & typeof fetch {
  return jsonBody(JSON.stringify(body), status);
}

function jsonBody(text: string, status = 200): ReturnType<typeof vi.fn> & typeof fetch {
  return vi.fn(async () => new Response(text, { status, headers: { "Content-Type": "application/json" } })) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

function sentPayload(fetchImpl: ReturnType<typeof vi.fn>): unknown {
  const init = fetchImpl.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as unknown;
}
