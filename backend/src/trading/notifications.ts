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

interface NotifyPayload {
  event: NotifyEvent;
  bot: string;
  symbol?: string;
  text: string;
}

/** Fire notifications to all enabled channels. Failures are swallowed (logged by caller). */
export async function notify(payload: NotifyPayload): Promise<void> {
  const config = getNotifyConfig();
  const icon = ICONS[payload.event];
  const message = `${icon} <b>${escapeHtml(payload.bot)}</b>${payload.symbol ? ` · ${escapeHtml(payload.symbol)}` : ""}\n${escapeHtml(payload.text)}`;
  const jobs: Promise<unknown>[] = [];
  if (config.telegram.enabled && config.telegram.token && config.telegram.chatId) {
    jobs.push(enqueueTelegram(config.telegram, message));
  }
  if (config.vk.enabled && config.vk.token && config.vk.peerId) {
    jobs.push(sendVk(config.vk, stripHtml(message)));
  }
  await Promise.allSettled(jobs);
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
    return Promise.resolve();
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
}

/** Send a test message to verify configuration. */
export async function testNotify(): Promise<{ ok: boolean; message: string }> {
  try {
    await notify({ event: "signal", bot: "SaltanatbotV2", text: "Test notification — channel is working." });
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
