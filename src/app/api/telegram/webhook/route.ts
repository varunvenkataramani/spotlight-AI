// Telegram calls this when someone presses Start, taps an answer button or writes to the bot.
// Only calls carrying the secret Spotlight gave Telegram are accepted, only linked admin chats can
// act, and the only thing a chat can do is link itself or answer an offer that was put to her.
import { NextResponse, type NextRequest } from "next/server";
import { demoNotFound } from "@/server/demo.ts";
import { getPool, query } from "@/lib/db.ts";
import { RESPONSE_LABEL, parseAnswerData } from "@/lib/alerts/rules.ts";
import { hashLinkCode, isTelegramWebhook, parseStartCode, telegram, type TelegramConfig } from "@/lib/alerts/telegram.ts";
import { answerForHer, EditError } from "@/server/actions.ts";
import { alertConfigOrNull } from "@/server/alerts.ts";
import type { AdminSession } from "@/server/session.ts";

export const dynamic = "force-dynamic";

type Chat = { id: number | string; type?: string };
type Update = {
  update_id: number;
  message?: { message_id: number; chat: Chat; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
};

const ok = () => NextResponse.json({ ok: true });

export async function POST(request: NextRequest) {
  const blocked = demoNotFound();
  if (blocked) return blocked;
  const cfg = alertConfigOrNull();
  if (!cfg?.telegram) return NextResponse.json({ error: "not_configured" }, { status: 404 });
  if (!isTelegramWebhook(request.headers.get("x-telegram-bot-api-secret-token"), cfg.telegram.webhookSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as Update | null;
  if (!update || !Number.isSafeInteger(update.update_id)) return ok();

  // Telegram may send the same update again; handle each once.
  const fresh = await query(`INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id`, [update.update_id]);
  if (fresh.length === 0) return ok();

  const tg = cfg.telegram;
  try {
    if (update.callback_query) await onButton(tg, cfg.admins, update.callback_query);
    else if (update.message) await onMessage(tg, cfg.admins, update.message);
  } catch (error) {
    console.error("Telegram update failed:", error instanceof Error ? error.name : "unknown error");
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (update.callback_query) await telegram(tg, "answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Something went wrong and nothing was saved. Try again." });
    else if (chatId !== undefined) await say(tg, chatId, "Something went wrong and nothing was saved. Try again.");
  }
  return ok();
}

async function say(tg: TelegramConfig, chatId: number | string, text: string, extra: object = {}) {
  await telegram(tg, "sendMessage", { chat_id: chatId, text, ...extra });
}

/** The admin this chat belongs to, if it's linked and they're still allowed in. */
async function adminForChat(chatId: number | string, admins: Set<string>): Promise<AdminSession | null> {
  const [u] = await query<{ id: string; email: string; name: string | null }>(`SELECT id, email, name FROM users WHERE telegram_chat_id = $1`, [String(chatId)]);
  return u && admins.has(u.email) ? { userId: u.id, email: u.email, name: u.name } : null;
}

async function onButton(tg: TelegramConfig, admins: Set<string>, q: NonNullable<Update["callback_query"]>) {
  const answer = (text: string, alert = false) => telegram(tg, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });
  const chat = q.message?.chat;
  const admin = chat && chat.type === "private" ? await adminForChat(chat.id, admins) : null;
  if (!admin || !chat) return void (await answer("This chat isn't connected to Spotlight.", true));
  if (q.data === "answered") return void (await answer("Already answered. Change it in Spotlight if you need to."));
  const parsed = parseAnswerData(q.data);
  if (!parsed) return void (await answer("That button no longer works."));

  try {
    await answerForHer(admin, parsed.oppId, parsed.answer, null, "telegram");
  } catch (error) {
    if (error instanceof EditError) return void (await answer(error.message, true));
    throw error;
  }
  await answer(`Saved: ${RESPONSE_LABEL[parsed.answer]}`);
  if (q.message) {
    await telegram(tg, "editMessageReplyMarkup", {
      chat_id: chat.id,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: `✓ You said: ${RESPONSE_LABEL[parsed.answer]}`, callback_data: "answered" }]] },
    });
  }
  if (parsed.answer === "questions") {
    await query(`UPDATE users SET telegram_awaiting_opportunity = $2, telegram_awaiting_until = now() + interval '30 minutes' WHERE id = $1`, [
      admin.userId,
      parsed.oppId,
    ]);
    await say(tg, chat.id, "What would you like to ask? Type it here and send. Your team will see it on the offer.", {
      reply_markup: { force_reply: true, input_field_placeholder: "Your question" },
    });
  }
}

async function onMessage(tg: TelegramConfig, admins: Set<string>, m: NonNullable<Update["message"]>) {
  if (m.chat.type !== "private") return; // the bot only works in one-to-one chats
  const text = typeof m.text === "string" ? m.text.trim() : "";
  const chatId = String(m.chat.id);

  if (text.startsWith("/start")) {
    const code = parseStartCode(text);
    if (!code) return say(tg, chatId, "To get Spotlight alerts here, open Spotlight → Settings and press “Connect Telegram”.");
    const linked = await linkChat(code, chatId, admins);
    return say(
      tg,
      chatId,
      linked
        ? `Connected. Spotlight alerts for ${linked} will come here. Send /stop to disconnect.`
        : "That link has expired or was already used. In Spotlight, open Settings and press “Connect Telegram” again.",
    );
  }
  if (text === "/stop") {
    const r = await query(
      `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_awaiting_opportunity = NULL, telegram_awaiting_until = NULL
       WHERE telegram_chat_id = $1 RETURNING id`,
      [chatId],
    );
    return say(tg, chatId, r.length ? "Disconnected. Alerts will no longer come here." : "This chat wasn't connected.");
  }

  const admin = await adminForChat(chatId, admins);
  if (!admin) return say(tg, chatId, "This chat isn't connected to Spotlight. Open Spotlight → Settings → “Connect Telegram”.");
  // After she tapped "Questions", her next message is the question. Read and clear in one step.
  const [waiting] = await query<{ opp: string | null }>(
    `WITH before AS (SELECT telegram_awaiting_opportunity AS opp, telegram_awaiting_until AS until FROM users WHERE id = $1 FOR UPDATE)
     UPDATE users u SET telegram_awaiting_opportunity = NULL, telegram_awaiting_until = NULL
     FROM before WHERE u.id = $1
     RETURNING CASE WHEN before.until > now() THEN before.opp END AS opp`,
    [admin.userId],
  );
  if (waiting?.opp && text && !text.startsWith("/")) {
    try {
      await answerForHer(admin, waiting.opp, "questions", text.slice(0, 1000), "telegram");
    } catch (error) {
      if (error instanceof EditError) return say(tg, chatId, error.message);
      throw error;
    }
    return say(tg, chatId, "Thanks. Your question is on the offer and your team has been told.");
  }
  return say(tg, chatId, "Spotlight sends alerts here. To answer an offer, use the buttons under it, or open Spotlight.");
}

async function linkChat(code: string, chatId: string, admins: Set<string>): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE telegram_link_hash = $1 AND telegram_link_expires_at > now() FOR UPDATE`,
      [hashLinkCode(code)],
    );
    const u = r.rows[0];
    if (!u || !admins.has(u.email)) {
      await client.query("ROLLBACK");
      return null;
    }
    // A chat belongs to one admin: linking it here unlinks it from anyone else.
    await client.query(`UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL WHERE telegram_chat_id = $1 AND id <> $2`, [chatId, u.id]);
    await client.query(
      `UPDATE users SET telegram_chat_id = $2, telegram_linked_at = now(), telegram_link_hash = NULL, telegram_link_expires_at = NULL,
              alert_channels = alert_channels || '{"telegram": true}'::jsonb
       WHERE id = $1`,
      [u.id, chatId],
    );
    await client.query("COMMIT");
    return u.email;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
