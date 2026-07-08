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
  const message = `${icon} <b>${escapeHtml(payload.bot)}</b>${payload.symbol ? ` · ${payload.symbol}` : ""}\n${escapeHtml(payload.text)}`;
  const jobs: Promise<unknown>[] = [];
  if (config.telegram.enabled && config.telegram.token && config.telegram.chatId) {
    jobs.push(sendTelegram(config.telegram, message));
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

async function sendTelegram(config: TelegramConfig, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
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
