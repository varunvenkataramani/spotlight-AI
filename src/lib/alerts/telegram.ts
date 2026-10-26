// Telegram bot: sending alerts with buttons, and checking that webhook calls really come from Telegram.
// The bot token is part of every API URL, so URLs and raw errors are never logged.
import crypto from "node:crypto";
import type { AlertAction } from "./rules.ts";

export type TelegramConfig = { token: string; apiBase: string; webhookSecret: string };

export const TELEGRAM_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

/** The secret Telegram sends back on every webhook call; derived, so there's nothing extra to set up. */
export function webhookSecretFor(token: string, sessionSecret: string): string {
  return crypto.createHmac("sha256", sessionSecret).update(`telegram-webhook:${token}`).digest("base64url");
}

export function isTelegramWebhook(headerValue: string | null, expected: string): boolean {
  if (!headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type TelegramResult<T> = { ok: true; result: T } | { ok: false; status: number; description: string; retryAfter: number | null };

export async function telegram<T = unknown>(cfg: TelegramConfig, method: string, body: object, timeoutMs = 8000): Promise<TelegramResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${cfg.apiBase}/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 0, description: "Telegram didn't answer", retryAfter: null };
  }
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;
  if (res.ok && data?.ok) return { ok: true, result: data.result as T };
  const description = typeof data?.description === "string" ? data.description.slice(0, 200) : `HTTP ${res.status}`;
  return { ok: false, status: res.status, description, retryAfter: data?.parameters?.retry_after ?? null };
}

/** A failed send that won't succeed on retry: the chat is gone or the bot was blocked. */
export const isPermanentTelegramFailure = (status: number) => status === 400 || status === 401 || status === 403 || status === 404;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type TelegramMessage = {
  chat_id: string;
  text: string;
  parse_mode: "HTML";
  disable_notification: boolean;
  link_preview_options: { is_disabled: true };
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };
};

/** Bold title, plain body, answer buttons in one row and an "Open" link below. Text is capped to Telegram's limit. */
export function alertMessage(
  chatId: string,
  alert: { title: string; body: string | null; url: string | null; actions: AlertAction[] },
  appUrl: string,
  silent: boolean,
): TelegramMessage {
  const text = `<b>${escapeHtml(alert.title)}</b>${alert.body ? `\n${escapeHtml(alert.body)}` : ""}`.slice(0, 3900);
  const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  if (alert.actions.length) rows.push(alert.actions.map((a) => ({ text: a.label, callback_data: a.data })));
  const link = alert.url && /^https:\/\//.test(appUrl) ? `${appUrl}${alert.url}` : null; // Telegram only accepts https links
  if (link) rows.push([{ text: "Open in Spotlight", url: link }]);
  return {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_notification: silent,
    link_preview_options: { is_disabled: true },
    ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
  };
}

/** A one-time code for linking a chat; the bot receives it as "/start <code>". Only its hash is stored. */
export function newLinkCode(): { code: string; hash: string } {
  const code = crypto.randomBytes(24).toString("base64url");
  return { code, hash: hashLinkCode(code) };
}

export const hashLinkCode = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

export function parseStartCode(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{20,64})\s*$/.exec(text.trim());
  return m ? m[1]! : null;
}
