// Alert settings, the Alerts page, Telegram linking and phone subscriptions for the signed-in admin.
import { getPool, query } from "@/lib/db.ts";
import { ConfigError, readAlertConfig, type AlertConfig } from "@/lib/config.ts";
import { EditError, parseClock } from "@/lib/edits.ts";
import { parseAlertTypes, type AlertTypes } from "@/lib/alerts/rules.ts";
import { deliverNotifications } from "@/lib/alerts/engine.ts";
import { newLinkCode, telegram } from "@/lib/alerts/telegram.ts";
import { isAllowedPushEndpoint } from "@/lib/alerts/webpush.ts";
import type { AdminSession } from "@/server/session.ts";

export function alertConfigOrNull(): AlertConfig | null {
  try {
    return readAlertConfig();
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

export type AlertSettings = {
  types: AlertTypes;
  channels: { push: boolean; telegram: boolean };
  quietStart: string;
  quietEnd: string;
  telegramConfigured: boolean;
  telegramLinked: boolean;
  telegramBot: string | null;
  phones: number;
  pushKey: string | null;
  talentEmail: string | null;
  recent: Array<{ channel: string; status: string; title: string; error: string | null; created_at: Date }>;
};

export async function getAlertSettings(admin: AdminSession): Promise<AlertSettings> {
  const cfg = alertConfigOrNull();
  const [rows, phones, prefs, recent] = await Promise.all([
    query<{ alert_types: unknown; alert_channels: { push?: boolean; telegram?: boolean }; q1: string | null; q2: string | null; telegram_chat_id: string | null }>(
      `SELECT alert_types, alert_channels, quiet_hours_start::text AS q1, quiet_hours_end::text AS q2, telegram_chat_id FROM users WHERE id = $1`,
      [admin.userId],
    ),
    query<{ n: string }>(`SELECT count(*) AS n FROM push_subscriptions WHERE user_id = $1`, [admin.userId]),
    query<{ key: string; value: unknown }>(`SELECT key, value FROM preferences WHERE key IN ('talent_email', 'telegram_bot_username')`),
    query<AlertSettings["recent"][number]>(
      `SELECT channel, status, title, error, created_at FROM notifications
       WHERE user_id = $1 AND channel <> 'in_app' ORDER BY created_at DESC LIMIT 5`,
      [admin.userId],
    ),
  ]);
  const u = rows[0];
  const pref = (k: string) => {
    const v = prefs.find((p) => p.key === k)?.value;
    return typeof v === "string" ? v : null;
  };
  return {
    types: parseAlertTypes(u?.alert_types),
    channels: { push: u?.alert_channels?.push !== false, telegram: u?.alert_channels?.telegram !== false },
    quietStart: (u?.q1 ?? "23:00").slice(0, 5),
    quietEnd: (u?.q2 ?? "08:00").slice(0, 5),
    telegramConfigured: Boolean(cfg?.telegram),
    telegramLinked: Boolean(u?.telegram_chat_id),
    telegramBot: pref("telegram_bot_username"),
    phones: Number(phones[0]?.n ?? 0),
    pushKey: cfg?.push.keys.publicKey ?? null,
    talentEmail: pref("talent_email"),
    recent,
  };
}

export async function saveAlertSettings(admin: AdminSession, form: FormData): Promise<string> {
  const newOffers = form.get("new_offers");
  if (newOffers !== "high" && newOffers !== "all" && newOffers !== "off") throw new EditError("Choose which new offers to hear about.");
  const types = { new_offers: newOffers, deadlines: form.get("deadlines") === "on", changes: form.get("changes") === "on", nudges: form.get("nudges") === "on" };
  const channels = { in_app: true, push: form.get("push") === "on", telegram: form.get("telegram") === "on" };
  const start = parseClock(form.get("quiet_start"));
  const end = parseClock(form.get("quiet_end"));
  await query(
    `UPDATE users SET alert_types = $2, alert_channels = $3, quiet_hours_start = $4::time, quiet_hours_end = $5::time WHERE id = $1`,
    [admin.userId, JSON.stringify(types), JSON.stringify(channels), start, end],
  );
  return start === end ? "Saved. Quiet hours are off." : `Saved. Phones stay quiet from ${start} to ${end} (India time).`;
}

export async function setTalent(admin: AdminSession, raw: unknown, admins: Set<string>): Promise<string> {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email === "") {
    await query(`UPDATE preferences SET value = 'null'::jsonb, updated_by = $1, updated_at = now() WHERE key = 'talent_email'`, [admin.userId]);
    return "Saved. Nobody is set as the actress.";
  }
  if (!admins.has(email)) throw new EditError("Choose one of the two admins.");
  await query(
    `INSERT INTO preferences (key, value, updated_by) VALUES ('talent_email', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(email), admin.userId],
  );
  return `Saved. “Flag for her” now goes to ${email}.`;
}

/**
 * Makes sure Telegram sends button taps to Spotlight, then gives a one-time link that opens the bot.
 * Pressing Start in Telegram links that chat to this admin.
 */
export async function startTelegramLink(admin: AdminSession): Promise<string> {
  const cfg = alertConfigOrNull();
  if (!cfg?.telegram) throw new EditError("Add TELEGRAM_BOT_TOKEN in Vercel first (see the steps above), then redeploy.");
  const me = await telegram<{ username?: string }>(cfg.telegram, "getMe", {});
  if (!me.ok || !me.result.username) {
    throw new EditError(me.ok || me.status !== 401 ? "Telegram didn't answer. Try again in a minute." : "Telegram didn't accept TELEGRAM_BOT_TOKEN. Copy it again from @BotFather.");
  }
  if (!/^https:\/\//.test(cfg.appUrl) && !process.env.TELEGRAM_API_BASE) {
    throw new EditError("Telegram needs the site's https address in APP_URL.");
  }
  const hook = await telegram(cfg.telegram, "setWebhook", {
    url: `${cfg.appUrl}/api/telegram/webhook`,
    secret_token: cfg.telegram.webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  if (!hook.ok) throw new EditError("Telegram couldn't be told where Spotlight is. Try again in a minute.");
  await query(
    `INSERT INTO preferences (key, value) VALUES ('telegram_bot_username', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(me.result.username)],
  );
  const { code, hash } = newLinkCode();
  await query(`UPDATE users SET telegram_link_hash = $2, telegram_link_expires_at = now() + interval '15 minutes' WHERE id = $1`, [admin.userId, hash]);
  return `https://t.me/${encodeURIComponent(me.result.username)}?start=${code}`;
}

export async function disconnectTelegram(admin: AdminSession): Promise<string> {
  await query(
    `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_link_hash = NULL, telegram_link_expires_at = NULL,
            telegram_awaiting_opportunity = NULL, telegram_awaiting_until = NULL
     WHERE id = $1`,
    [admin.userId],
  );
  await query(`UPDATE notifications SET status = 'suppressed', error = 'Telegram was disconnected.' WHERE user_id = $1 AND channel = 'telegram' AND status = 'pending'`, [admin.userId]);
  return "Telegram disconnected. Alerts still show in Spotlight.";
}

/** A test alert on every channel this admin uses, sent straight away. */
export async function sendTestAlert(admin: AdminSession): Promise<string> {
  const cfg = alertConfigOrNull();
  if (!cfg) throw new EditError("Alerts aren't set up: check APP_URL, ADMIN_EMAILS and SESSION_SECRET in Vercel.");
  const key = `test:${admin.userId}:${Date.now()}`;
  const [u] = await query<{ telegram_chat_id: string | null; alert_channels: { push?: boolean; telegram?: boolean }; phones: string }>(
    `SELECT telegram_chat_id, alert_channels, (SELECT count(*) FROM push_subscriptions WHERE user_id = $1) AS phones FROM users WHERE id = $1`,
    [admin.userId],
  );
  const channels = ["in_app"];
  if (cfg.telegram && u?.telegram_chat_id && u.alert_channels?.telegram !== false) channels.push("telegram");
  if (Number(u?.phones ?? 0) > 0 && u?.alert_channels?.push !== false) channels.push("push");
  await query(
    `INSERT INTO notifications (event_key, user_id, channel, kind, title, body, url, status, sent_at)
     SELECT $1, $2, ch, 'test', 'Test alert from Spotlight', 'If you can read this, alerts reach you here.', '/alerts',
            CASE WHEN ch = 'in_app' THEN 'sent' ELSE 'pending' END, CASE WHEN ch = 'in_app' THEN now() END
     FROM unnest($3::text[]) AS ch`,
    [key, admin.userId, channels],
  );
  if (channels.length > 1) await deliverNotifications(cfg, Date.now() + 8_000);
  const sent = await query<{ channel: string; status: string }>(`SELECT channel, status FROM notifications WHERE event_key = $1`, [key]);
  const label = (ch: string) => (ch === "push" ? "this phone or browser" : ch === "telegram" ? "Telegram" : "Spotlight");
  const ok = sent.filter((s) => s.status === "sent").map((s) => label(s.channel));
  const notYet = sent.filter((s) => s.status !== "sent").map((s) => label(s.channel));
  return `Test sent to ${ok.join(", ")}.${notYet.length ? ` Not delivered yet to ${notYet.join(", ")}: see “Recent deliveries” below.` : ""}`;
}

// --- Phones and browsers (Web Push) ---------------------------------------------------------------------------

export async function savePushSubscription(admin: AdminSession, body: unknown, userAgent: string | null): Promise<void> {
  const cfg = alertConfigOrNull();
  if (!cfg) throw new EditError("Alerts aren't set up.");
  const sub = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
  const p256dh = typeof sub?.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub?.keys?.auth === "string" ? sub.keys.auth : "";
  if (endpoint.length > 1000 || !isAllowedPushEndpoint(endpoint, cfg.push.extraOrigins)) throw new EditError("This browser's push service isn't supported.");
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) throw new EditError("This browser sent an unusable subscription.");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const count = await client.query(`SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND endpoint <> $2`, [admin.userId, endpoint]);
    if ((count.rowCount ?? 0) >= 5) {
      // Keep the five most recent devices.
      await client.query(
        `DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2)`,
        [admin.userId, (count.rowCount ?? 0) - 4],
      );
    }
    await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, user_agent, server_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, user_agent = EXCLUDED.user_agent,
                                            server_key = EXCLUDED.server_key, failures = 0`,
      [admin.userId, endpoint, JSON.stringify({ p256dh, auth }), userAgent?.slice(0, 200) ?? null, cfg.push.keys.publicKey],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function removePushSubscription(admin: AdminSession, endpoint: unknown): Promise<void> {
  if (typeof endpoint !== "string") return;
  await query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [admin.userId, endpoint]);
}

// --- The Alerts page ------------------------------------------------------------------------------------------

export type AlertItem = { id: string; kind: string; title: string; body: string | null; url: string | null; read_at: Date | null; created_at: Date };

export async function listAlerts(admin: AdminSession): Promise<AlertItem[]> {
  return query<AlertItem>(
    `SELECT id, kind, title, body, url, read_at, created_at FROM notifications
     WHERE user_id = $1 AND channel = 'in_app' ORDER BY created_at DESC LIMIT 100`,
    [admin.userId],
  );
}

export async function markAlertsRead(admin: AdminSession): Promise<void> {
  await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [admin.userId]);
}

export async function unreadAlertCount(userId: string): Promise<number> {
  const [r] = await query<{ n: string }>(
    `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
    [userId],
  );
  return Number(r?.n ?? 0);
}
