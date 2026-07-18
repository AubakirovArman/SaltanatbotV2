/**
 * Minimal Telegram Bot API client for the notification worker.
 *
 * Only the three methods the worker needs exist: `getMe` (one-time token
 * validation), `sendMessage` (delivery lane; plain text, NO parse_mode so an
 * alert title can never inject markup) and `getUpdates` (ingress long poll).
 *
 * Failure discipline: every response body read is byte-bounded, every request
 * carries an abort timeout, HTTP 429 surfaces Telegram's `retry_after` as a
 * typed error, and no error message ever contains the URL (the URL embeds the
 * bot token). Callers own the capped backoff between retries.
 */

export const TELEGRAM_GET_UPDATES_TIMEOUT_SECONDS = 25;
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_BYTE_LIMIT = 1_048_576;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4_096;

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

/** HTTP 429: honour Telegram's requested pause before the next attempt. */
export class TelegramRateLimitError extends TelegramApiError {
  constructor(readonly retryAfterMs: number) {
    super(`Telegram asked to retry after ${Math.ceil(retryAfterMs / 1_000)}s`, true);
  }
}

export interface TelegramUpdateEnvelope {
  readonly update_id: number;
  readonly message?: {
    readonly chat?: { readonly id?: number | string; readonly type?: string };
    readonly text?: string;
  };
}

export interface TelegramApiOptions {
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export class TelegramApi {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly token: string,
    options: TelegramApiOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** One-shot token validation at lane activation. */
  async getMe(): Promise<{ id: number; isBot: boolean }> {
    const result = await this.call("getMe", {}, this.requestTimeoutMs);
    const user = result as { id?: unknown; is_bot?: unknown };
    if (!Number.isSafeInteger(user.id) || typeof user.is_bot !== "boolean") {
      throw new TelegramApiError("Telegram getMe returned an invalid user object", false);
    }
    return { id: user.id as number, isBot: user.is_bot };
  }

  /** Plain-text send; returns the provider message id used as the delivery receipt. */
  async sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
    const bounded = text.length > TELEGRAM_MESSAGE_TEXT_LIMIT ? `${text.slice(0, TELEGRAM_MESSAGE_TEXT_LIMIT - 1)}…` : text;
    const result = await this.call(
      "sendMessage",
      { chat_id: chatId, text: bounded, disable_web_page_preview: true },
      this.requestTimeoutMs
    );
    const messageId = (result as { message_id?: unknown }).message_id;
    if (!Number.isSafeInteger(messageId)) {
      throw new TelegramApiError("Telegram sendMessage returned no message id", false);
    }
    return { messageId: String(messageId) };
  }

  /** Long poll; the timeout budget covers the server-side wait plus a margin. */
  async getUpdates(offset: number, timeoutSeconds = TELEGRAM_GET_UPDATES_TIMEOUT_SECONDS): Promise<TelegramUpdateEnvelope[]> {
    const result = await this.call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      (timeoutSeconds + 10) * 1_000
    );
    if (!Array.isArray(result)) {
      throw new TelegramApiError("Telegram getUpdates returned a non-array result", true);
    }
    return result.filter(isUpdateEnvelope);
  }

  private async call(method: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      throw new TelegramApiError(`Telegram ${method} request failed: ${networkErrorKind(error)}`, true);
    } finally {
      clearTimeout(timer);
    }
    const body = await readBoundedJson(response, method);
    if (response.status === 429) throw new TelegramRateLimitError(retryAfterMs(body));
    if (!response.ok) {
      throw new TelegramApiError(`Telegram ${method} HTTP ${response.status}`, response.status >= 500);
    }
    const envelope = body as { ok?: unknown; result?: unknown };
    if (envelope?.ok !== true) throw new TelegramApiError(`Telegram ${method} reported ok=false`, false);
    return envelope.result;
  }
}

/** Read at most RESPONSE_BYTE_LIMIT bytes, then parse JSON (undefined when invalid). */
async function readBoundedJson(response: Response, method: string): Promise<unknown> {
  let text: string;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > RESPONSE_BYTE_LIMIT) {
          await reader.cancel().catch(() => undefined);
          throw new TelegramApiError(`Telegram ${method} response exceeded ${RESPONSE_BYTE_LIMIT} bytes`, true);
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } else {
      text = await response.text();
      if (Buffer.byteLength(text, "utf8") > RESPONSE_BYTE_LIMIT) {
        throw new TelegramApiError(`Telegram ${method} response exceeded ${RESPONSE_BYTE_LIMIT} bytes`, true);
      }
    }
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError(`Telegram ${method} response could not be read`, true);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function retryAfterMs(body: unknown): number {
  const parameters = (body as { parameters?: { retry_after?: unknown } } | undefined)?.parameters;
  const retryAfter = parameters?.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(retryAfter * 1_000));
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function isUpdateEnvelope(value: unknown): value is TelegramUpdateEnvelope {
  return Boolean(value) && typeof value === "object" && Number.isSafeInteger((value as { update_id?: unknown }).update_id);
}

function networkErrorKind(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  // Never propagate raw fetch error text: some runtimes echo the URL (token).
  return "network error";
}
