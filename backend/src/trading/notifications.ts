import { getSetting } from "./store.js";

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chatId: string;
  /**
   * Enable INBOUND two-way control (the Telegram poller that lets the operator
   * command bots from chat). Optional and backward-compatible: when omitted the
   * control channel follows `enabled`. Set it false to keep outbound
   * notifications on while disabling remote control.
   */
  control?: boolean;
}

export interface VkConfig {
  enabled: boolean;
  token: string;
  peerId: string;
}

export interface NotifyConfig {
  telegram: TelegramConfig;
  vk: VkConfig;
}

export const DEFAULT_NOTIFY: NotifyConfig = {
  telegram: { enabled: false, token: "", chatId: "" },
  vk: { enabled: false, token: "", peerId: "" }
};

export function getNotifyConfig(): NotifyConfig {
  return getSetting<NotifyConfig>("notify") ?? DEFAULT_NOTIFY;
}

/**
 * Whether inbound Telegram control should be active: the channel must be
 * configured (token + chatId) and enabled. Control follows `enabled` unless the
 * optional `control` flag is set explicitly (`false` keeps outbound-only).
 */
export function isTelegramControlEnabled(config: TelegramConfig = getNotifyConfig().telegram): boolean {
  if (!config.token || !config.chatId) return false;
  if (!config.enabled) return false;
  return config.control ?? true;
}

export type NotifyEvent = "start" | "stop" | "open" | "close" | "error" | "signal";

export interface NotifyPayload {
  event: NotifyEvent;
  bot: string;
  symbol?: string;
  text: string;
}

export interface NotifyDeliveryReport {
  attemptedChannels: Array<"telegram" | "vk">;
  deliveredChannels: Array<"telegram" | "vk">;
  failures: Array<{ channel: "telegram" | "vk"; message: string }>;
}

export class NotificationDeliveryError extends Error {
  constructor(
    message: string,
    readonly report: NotifyDeliveryReport
  ) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}

/** Best-effort compatibility path used by bot lifecycle notifications. */
export async function notify(payload: NotifyPayload): Promise<void> {
  await dispatchNotification(payload);
}

/**
 * Checked delivery for durable outboxes. It rejects when no channel is
 * configured or any enabled channel fails, allowing the caller to persist a
 * retry instead of treating Promise.allSettled() as successful delivery.
 */
export async function notifyChecked(payload: NotifyPayload): Promise<NotifyDeliveryReport> {
  const report = await dispatchNotification(payload);
  if (report.attemptedChannels.length === 0) throw new NotificationDeliveryError("No enabled notification channel is configured", report);
  if (report.failures.length > 0) {
    throw new NotificationDeliveryError(`Notification delivery failed: ${report.failures.map((failure) => `${failure.channel}: ${failure.message}`).join("; ")}`, report);
  }
  return report;
}

async function dispatchNotification(payload: NotifyPayload): Promise<NotifyDeliveryReport> {
  const config = getNotifyConfig();
  const icon = ICONS[payload.event];
  const message = `${icon} <b>${escapeHtml(payload.bot)}</b>${payload.symbol ? ` · ${escapeHtml(payload.symbol)}` : ""}\n${escapeHtml(payload.text)}`;
  const jobs: Array<{ channel: "telegram" | "vk"; promise: Promise<unknown> }> = [];
  if (config.telegram.enabled && config.telegram.token && config.telegram.chatId) {
    jobs.push({ channel: "telegram", promise: enqueueTelegram(config.telegram, message) });
  }
  if (config.vk.enabled && config.vk.token && config.vk.peerId) {
    jobs.push({ channel: "vk", promise: sendVk(config.vk, stripHtml(message)) });
  }
  const settled = await Promise.allSettled(jobs.map((job) => job.promise));
  const report: NotifyDeliveryReport = { attemptedChannels: jobs.map((job) => job.channel), deliveredChannels: [], failures: [] };
  settled.forEach((result, index) => {
    const channel = jobs[index]!.channel;
    if (result.status === "fulfilled") report.deliveredChannels.push(channel);
    else report.failures.push({ channel, message: errorMessage(result.reason) });
  });
  return report;
}

const ICONS: Record<NotifyEvent, string> = {
  start: "▶️",
  stop: "⏹️",
  open: "🟢",
  close: "🔵",
  error: "⚠️",
  signal: "🔔"
};

// ---------- Telegram outbound rate limiting ----------
// Telegram allows ~1 message/second per chat. A strategy that alerts every
// closed bar across several bots will otherwise trip HTTP 429 and, since sends
// are fire-and-forget, silently drop notifications. We serialize sends per chat
// through a queue that spaces them out, honors `retry_after` on 429, and caps
// the backlog so a runaway strategy can't grow memory unbounded.

const CHAT_MIN_INTERVAL_MS = 1100;
const MAX_PENDING_PER_CHAT = 20;
const chatQueues = new Map<string, Promise<void>>();
const chatPending = new Map<string, number>();
const chatDropped = new Map<string, number>();
const lastSentAt = new Map<string, number>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Serialize + throttle Telegram sends per chat so bursts don't get 429'd/dropped. */
function enqueueTelegram(config: TelegramConfig, text: string): Promise<void> {
  const chatId = config.chatId;
  const pending = chatPending.get(chatId) ?? 0;
  if (pending >= MAX_PENDING_PER_CHAT) {
    // Backlog full — drop this message but remember we did, so the next one that
    // gets through can report the flood instead of failing silently.
    chatDropped.set(chatId, (chatDropped.get(chatId) ?? 0) + 1);
    return Promise.reject(new Error(`Telegram queue for chat ${chatId} is full`));
  }
  chatPending.set(chatId, pending + 1);
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const dropped = chatDropped.get(chatId) ?? 0;
      const body = dropped > 0 ? `${text}\n<i>(${dropped} earlier alert${dropped === 1 ? "" : "s"} dropped — rate limited)</i>` : text;
      if (dropped > 0) chatDropped.delete(chatId);
      await throttledSend(config, body);
    })
    .finally(() => {
      chatPending.set(chatId, Math.max(0, (chatPending.get(chatId) ?? 1) - 1));
    });
  chatQueues.set(chatId, next);
  return next;
}

async function throttledSend(config: TelegramConfig, text: string) {
  const now = Date.now();
  const wait = Math.max(0, (lastSentAt.get(config.chatId) ?? 0) + CHAT_MIN_INTERVAL_MS - now);
  if (wait > 0) await sleep(wait);
  lastSentAt.set(config.chatId, Date.now());
  await sendTelegram(config, text);
}

async function sendTelegram(config: TelegramConfig, text: string, attempt = 0) {
  const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (res.status === 429 && attempt < 3) {
    const info = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
    const retryMs = Math.min(60_000, ((info.parameters?.retry_after ?? 1) + 0.5) * 1000);
    await sleep(retryMs);
    lastSentAt.set(config.chatId, Date.now());
    return sendTelegram(config, text, attempt + 1);
  }
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  const body = (await res.json().catch(() => undefined)) as { ok?: boolean; description?: string } | undefined;
  if (body?.ok === false) throw new Error(`Telegram API: ${body.description ?? "request rejected"}`);
}

async function sendVk(config: VkConfig, text: string) {
  const params = new URLSearchParams({
    access_token: config.token,
    peer_id: config.peerId,
    message: text,
    random_id: String(Date.now()),
    v: "5.199"
  });
  const res = await fetch(`https://api.vk.com/method/messages.send?${params}`, { method: "POST" });
  if (!res.ok) throw new Error(`VK HTTP ${res.status}`);
  const body = (await res.json().catch(() => undefined)) as { error?: { error_code?: number; error_msg?: string } } | undefined;
  if (body?.error) throw new Error(`VK API ${body.error.error_code ?? "error"}: ${body.error.error_msg ?? "request rejected"}`);
}

/** Send a test message to verify configuration. */
export async function testNotify(): Promise<{ ok: boolean; message: string }> {
  try {
    await notifyChecked({ event: "signal", bot: "SaltanatbotV2", text: "Test notification — channel is working." });
    return { ok: true, message: "Sent" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed" };
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
