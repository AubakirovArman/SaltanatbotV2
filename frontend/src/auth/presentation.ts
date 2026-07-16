import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import { AuthApiError } from "./client";
import { authErrorText, authText } from "./messages";
import type { AppRole, AuthSessionSummary, TradingRole } from "./types";

export function appRoleLabel(locale: Locale, role: AppRole): string {
  return authText(locale, role === "admin" ? "adminRole" : "userRole");
}

export function tradingRoleLabel(locale: Locale, role: TradingRole): string {
  if (role === "live-trade") return authText(locale, "dormantLiveTrade");
  const keys = {
    none: "noTrading",
    "read-only": "readOnly",
    "paper-trade": "paperTrade"
  } as const;
  return authText(locale, keys[role]);
}

export function authErrorMessage(locale: Locale, cause: unknown): string {
  return cause instanceof AuthApiError ? authErrorText(locale, cause.code) : authText(locale, "errorGeneric");
}

export function formatAuthTime(locale: Locale, value?: string): string {
  if (!value) return authText(locale, "never");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return authText(locale, "never");
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "medium", timeStyle: "short" }).format(time);
}

export function sessionDeviceLabel(locale: Locale, session: AuthSessionSummary): string {
  const userAgent = session.userAgent?.trim();
  if (!userAgent) return authText(locale, "unknownDevice");
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : undefined;
  const platform = /Android/i.test(userAgent)
    ? "Android"
    : /iPhone|iPad/i.test(userAgent)
      ? "iOS"
      : /Windows/i.test(userAgent)
        ? "Windows"
        : /Macintosh|Mac OS/i.test(userAgent)
          ? "macOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : undefined;
  return [browser, platform].filter(Boolean).join(" · ") || userAgent.slice(0, 80);
}
