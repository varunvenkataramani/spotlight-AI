// Alerts in the scheduled run: work out what's worth telling each admin (rules.ts), record one
// notification per person and channel (the database refuses repeats), then send what's due to
// Telegram and to phones, with retries. Notification text is never logged.
import type pg from "pg";
import { getPool, query } from "../db.ts";
import type { AlertConfig } from "../config.ts";
import { payText } from "../format.ts";
import {
  CLOSED_STATUSES,
  emailAlerts,
  opportunityAlerts,
  parseAlertTypes,
  quietHoursEnd,
  wantsAlert,
  type AlertEvent,
  type EmailActivity,
  type Recipient,
} from "./rules.ts";
import { alertMessage, isPermanentTelegramFailure, telegram } from "./telegram.ts";
import { isAllowedPushEndpoint, sendPush, type PushSubscriptionKeys } from "./webpush.ts";

export type AlertReport = { created: number; sent: number; failed: number; waiting: number };

const OUR_TURN = ["new", "reviewed", "interested", "needs_information", "awaiting_my_response", "reply_drafted"];
const MAX_ATTEMPTS = 5;
/** Alerts that ring even in quiet hours: a reply due within hours, and reminders someone set on purpose. */
const isUrgentKey = (key: string) => key.startsWith("reply_due_soon:") || key.startsWith("reminder:");

type Person = Recipient & {
  email: string;
  channels: { in_app?: boolean; push?: boolean; telegram?: boolean };
  quietStart: string | null;
  quietEnd: string | null;
  timeZone: string;
  telegramChatId: string | null;
  hasPush: boolean;
};

export async function loadPeople(runner: Pick<pg.PoolClient, "query">, admins: Set<string>): Promise<Person[]> {
  const talent = await runner.query<{ value: unknown }>(`SELECT value FROM preferences WHERE key = 'talent_email'`);
  const talentEmail = typeof talent.rows[0]?.value === "string" ? (talent.rows[0].value as string) : null;
  const { rows } = await runner.query<{
    id: string;
    email: string;
    alert_types: unknown;
    alert_channels: Person["channels"];
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    timezone: string;
    telegram_chat_id: string | null;
    has_push: boolean;
  }>(
    `SELECT u.id, u.email, u.alert_types, u.alert_channels, u.quiet_hours_start::text, u.quiet_hours_end::text, u.timezone, u.telegram_chat_id,
            EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id) AS has_push
     FROM users u WHERE u.email = ANY($1::text[])`,
    [[...admins]],
  );
  return rows.map((r) => ({
    userId: r.id,
    email: r.email,
    isTalent: r.email === talentEmail,
    types: parseAlertTypes(r.alert_types),
    channels: r.alert_channels ?? {},
    quietStart: r.quiet_hours_start,
    quietEnd: r.quiet_hours_end,
    timeZone: r.timezone,
    telegramChatId: r.telegram_chat_id,
    hasPush: r.has_push,
  }));
}

type OppRow = {
  id: string;
  title: string;
  organization: string | null;
  priority: string;
  status: string;
  is_irrelevant: boolean;
  from_historical: boolean;
  created_at: Date;
  snoozed_until: Date | null;
  reply_by_at: Date | null;
  event_start_at: Date | null;
  next_deadline_at: Date | null;
  last_touch_at: Date;
  compensation_type: string;
  compensation_status: string;
  amount_min: string | null;
  amount_max: string | null;
  currency: string;
  red_flag_count: number;
  flagged_for_talent_at: Date | null;
  flag_note: string | null;
  flagged_by_name: string | null;
  talent_response: "interested" | "pass" | "questions" | null;
  talent_response_note: string | null;
  talent_responded_at: Date | null;
};

/** Everything worth announcing right now, from stored state only. */
export async function collectEvents(c: pg.PoolClient, now: Date): Promise<AlertEvent[]> {
  const events: AlertEvent[] = [];

  const opps = await c.query<OppRow>(
    `SELECT o.id, o.title, o.organization, o.priority, o.status, o.is_irrelevant, o.from_historical, o.created_at, o.snoozed_until,
            o.reply_by_at, o.event_start_at, o.next_deadline_at,
            GREATEST(o.last_activity_at, o.created_at,
                     (SELECT max(a.created_at) FROM activities a WHERE a.opportunity_id = o.id AND a.actor_type = 'user')) AS last_touch_at,
            o.compensation_type, o.compensation_status, o.amount_min, o.amount_max, o.currency,
            jsonb_array_length(o.red_flags) AS red_flag_count,
            o.flagged_for_talent_at, f.detail->>'note' AS flag_note, fu.name AS flagged_by_name,
            o.talent_response, o.talent_response_note, o.talent_responded_at
     FROM opportunities o
     LEFT JOIN LATERAL (SELECT detail FROM activities WHERE opportunity_id = o.id AND kind = 'flagged_for_her' ORDER BY created_at DESC LIMIT 1) f ON true
     LEFT JOIN users fu ON fu.id = o.flagged_by
     WHERE NOT o.is_irrelevant AND o.status <> ALL($2::text[])
       AND (o.created_at > $1::timestamptz - interval '6 hours'
         OR o.reply_by_at BETWEEN $1::timestamptz AND $1::timestamptz + interval '1 day'
         OR o.event_start_at BETWEEN $1::timestamptz AND $1::timestamptz + interval '1 day'
         OR o.next_deadline_at BETWEEN $1::timestamptz AND $1::timestamptz + interval '1 day'
         OR o.snoozed_until BETWEEN $1::timestamptz - interval '6 hours' AND $1::timestamptz
         OR o.flagged_for_talent_at > $1::timestamptz - interval '7 days'
         OR o.talent_responded_at > $1::timestamptz - interval '6 hours'
         OR (o.status = ANY($3::text[]) AND NOT o.from_historical AND o.priority IN ('high', 'medium'))
         OR o.status = 'awaiting_their_response')
     ORDER BY o.last_activity_at DESC
     LIMIT 300`,
    [now, CLOSED_STATUSES, OUR_TURN],
  );
  for (const o of opps.rows) {
    events.push(
      ...opportunityAlerts(
        {
          id: o.id,
          title: o.title,
          organization: o.organization,
          priority: o.priority,
          status: o.status,
          isIrrelevant: o.is_irrelevant,
          fromHistorical: o.from_historical,
          createdAt: o.created_at,
          snoozedUntil: o.snoozed_until,
          replyByAt: o.reply_by_at,
          eventStartAt: o.event_start_at,
          nextDeadlineAt: o.next_deadline_at,
          lastTouchAt: o.last_touch_at,
          pay: payText(o),
          redFlagCount: Number(o.red_flag_count) || 0,
          flaggedAt: o.flagged_for_talent_at,
          flagNote: o.flag_note,
          flaggedByName: o.flagged_by_name,
          talentResponse: o.talent_response,
          talentResponseNote: o.talent_response_note,
          talentRespondedAt: o.talent_responded_at,
        },
        now,
      ),
    );
  }

  // Their new emails on offers we already track (not old mail from the first scan).
  const acts = await c.query<{
    opportunity_id: string;
    kind: EmailActivity["kind"];
    detail: Record<string, unknown>;
    title: string;
    organization: string | null;
    is_irrelevant: boolean;
    status: string;
  }>(
    `SELECT a.opportunity_id, a.kind, a.detail, o.title, o.organization, o.is_irrelevant, o.status
     FROM activities a
     JOIN opportunities o ON o.id = a.opportunity_id
     LEFT JOIN emails e ON e.id = CASE WHEN a.detail->>'emailId' ~ '^[0-9a-f-]{36}$' THEN (a.detail->>'emailId')::uuid END
     WHERE a.kind IN ('email_received', 'change_detected', 'cancellation_detected')
       AND a.created_at > $1::timestamptz - interval '6 hours'
       AND e.id IS NOT NULL AND NOT e.is_historical
     ORDER BY a.id`,
    [now],
  );
  const byOpp = new Map<string, { ref: Parameters<typeof emailAlerts>[0]; list: EmailActivity[] }>();
  for (const a of acts.rows) {
    const entry = byOpp.get(a.opportunity_id) ?? {
      ref: { id: a.opportunity_id, title: a.title, organization: a.organization, isIrrelevant: a.is_irrelevant, status: a.status },
      list: [],
    };
    entry.list.push({
      kind: a.kind,
      emailId: String(a.detail.emailId),
      field: typeof a.detail.field === "string" ? a.detail.field : undefined,
      from: typeof a.detail.from === "string" ? a.detail.from : undefined,
      to: typeof a.detail.to === "string" ? a.detail.to : undefined,
    });
    byOpp.set(a.opportunity_id, entry);
  }
  for (const { ref, list } of byOpp.values()) events.push(...emailAlerts(ref, list));

  // Reminders an admin set. Marked as sent in this same transaction, with their notifications.
  const due = await c.query<{ id: string; opportunity_id: string | null; note: string | null; for_user: string | null; title: string | null; organization: string | null }>(
    `UPDATE reminders r SET status = 'sent'
     FROM (SELECT r2.id, o.title, o.organization FROM reminders r2 LEFT JOIN opportunities o ON o.id = r2.opportunity_id
           WHERE r2.status = 'pending' AND r2.kind = 'custom' AND r2.due_at <= $1::timestamptz
           ORDER BY r2.due_at LIMIT 50 FOR UPDATE OF r2 SKIP LOCKED) d
     WHERE r.id = d.id
     RETURNING r.id, r.opportunity_id, r.note, r.for_user, d.title, d.organization`,
    [now],
  );
  for (const r of due.rows) {
    events.push({
      key: `reminder:${r.id}`,
      kind: "reminder",
      opportunityId: r.opportunity_id,
      title: r.note ? `Reminder: ${r.note}` : "Reminder",
      body: r.title ? `${r.title}${r.organization ? ` · ${r.organization}` : ""}` : "",
      url: r.opportunity_id ? `/opportunities/${r.opportunity_id}` : "/",
      audience: r.for_user ? { userId: r.for_user } : "everyone",
      urgent: true,
      actions: [],
    });
  }

  // The inbox stopped working: once a day until it's reconnected.
  const broken = await c.query<{ id: string; email: string }>(`SELECT id, email FROM gmail_accounts WHERE status IN ('needs_reconnect', 'revoked')`);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  for (const g of broken.rows) {
    events.push({
      key: `gmail_reconnect:${g.id}:${today}`,
      kind: "gmail_reconnect",
      opportunityId: null,
      title: "Gmail needs reconnecting",
      body: `Spotlight can't read ${g.email} until someone reconnects it in Settings. New offers won't show up until then.`,
      url: "/settings",
      audience: "everyone",
      urgent: false,
      actions: [],
    });
  }
  return events;
}

type NewRow = { event: AlertEvent; userId: string; channel: "in_app" | "push" | "telegram"; deliverAfter: Date };

/** One row per person and channel they use; repeats are dropped by the database. Returns how many are new. */
export async function recordNotifications(c: pg.PoolClient, events: AlertEvent[], people: Person[], cfg: AlertConfig, now: Date): Promise<number> {
  const rows: NewRow[] = [];
  for (const event of events) {
    for (const p of people) {
      if (!wantsAlert(p, event)) continue;
      rows.push({ event, userId: p.userId, channel: "in_app", deliverAfter: now });
      if (cfg.telegram && p.telegramChatId && p.channels.telegram !== false) rows.push({ event, userId: p.userId, channel: "telegram", deliverAfter: now });
      if (p.hasPush && p.channels.push !== false) {
        const quiet = event.urgent ? null : quietHoursEnd(now, p.quietStart, p.quietEnd, p.timeZone);
        rows.push({ event, userId: p.userId, channel: "push", deliverAfter: quiet ?? now });
      }
    }
  }
  if (rows.length === 0) return 0;
  const r = await c.query(
    `INSERT INTO notifications (event_key, user_id, opportunity_id, channel, kind, title, body, url, actions, deliver_after, status, sent_at)
     SELECT t.key, t.user_id, t.opp, t.channel, t.kind, t.title, t.body, t.url, t.actions, t.after,
            CASE WHEN t.channel = 'in_app' THEN 'sent' ELSE 'pending' END,
            CASE WHEN t.channel = 'in_app' THEN $11::timestamptz END
     FROM unnest($1::text[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::timestamptz[])
          AS t(key, user_id, opp, channel, kind, title, body, url, actions, after)
     WHERE t.opp IS NULL OR EXISTS (SELECT 1 FROM opportunities o WHERE o.id = t.opp)
     ON CONFLICT (event_key, user_id, channel) DO NOTHING`,
    [
      rows.map((x) => x.event.key),
      rows.map((x) => x.userId),
      rows.map((x) => x.event.opportunityId),
      rows.map((x) => x.channel),
      rows.map((x) => x.event.kind),
      rows.map((x) => x.event.title.slice(0, 200)),
      rows.map((x) => x.event.body.slice(0, 2000)),
      rows.map((x) => x.event.url),
      rows.map((x) => JSON.stringify(x.event.actions)),
      rows.map((x) => x.deliverAfter),
      now,
    ],
  );
  return r.rowCount ?? 0;
}

type Outgoing = {
  id: string;
  user_id: string;
  channel: "push" | "telegram";
  event_key: string;
  title: string;
  body: string | null;
  url: string | null;
  actions: Array<{ label: string; data: string }>;
  attempts: number;
};

async function finish(id: string, outcome: "sent" | "failed" | "suppressed" | "retry", error: string | null, retryAt?: Date) {
  if (outcome === "retry") {
    await query(`UPDATE notifications SET error = $2, next_attempt_at = COALESCE($3, next_attempt_at) WHERE id = $1`, [id, error, retryAt ?? null]);
    return;
  }
  await query(`UPDATE notifications SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`, [id, outcome, error]);
}

/** Sends what's due, a few at a time, until the time budget runs out. */
export async function deliverNotifications(cfg: AlertConfig, deadline: number): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  // Anything still unsent after a day is no longer useful.
  await query(
    `UPDATE notifications SET status = 'suppressed', error = 'Not sent within a day, so dropped.'
     WHERE status = 'pending' AND deliver_after < now() - interval '1 day'`,
  );
  while (Date.now() < deadline) {
    const batch = await query<Outgoing>(
      `UPDATE notifications n
       SET attempts = n.attempts + 1,
           next_attempt_at = now() + (CASE n.attempts WHEN 0 THEN 1 WHEN 1 THEN 5 WHEN 2 THEN 15 ELSE 60 END) * interval '1 minute'
       WHERE n.id IN (SELECT id FROM notifications
                      WHERE status = 'pending' AND channel IN ('push', 'telegram') AND deliver_after <= now()
                        AND (next_attempt_at IS NULL OR next_attempt_at <= now()) AND attempts < ${MAX_ATTEMPTS}
                      ORDER BY deliver_after, created_at LIMIT 8 FOR UPDATE SKIP LOCKED)
       RETURNING n.id, n.user_id, n.channel, n.event_key, n.title, n.body, n.url, n.actions, n.attempts`,
    );
    if (batch.length === 0) break;
    for (const n of batch) {
      if (Date.now() >= deadline) break; // claimed but unsent: it's retried next run
      const result = n.channel === "telegram" ? await sendTelegram(cfg, n) : await sendPushes(cfg, n);
      if (result.outcome === "retry" && n.attempts >= MAX_ATTEMPTS) result.outcome = "failed";
      await finish(n.id, result.outcome, result.error, result.retryAt);
      if (result.outcome === "sent") sent++;
      if (result.outcome === "failed") failed++;
    }
  }
  return { sent, failed };
}

type SendResult = { outcome: "sent" | "failed" | "suppressed" | "retry"; error: string | null; retryAt?: Date };

async function sendTelegram(cfg: AlertConfig, n: Outgoing): Promise<SendResult> {
  if (!cfg.telegram) return { outcome: "suppressed", error: "Telegram isn't set up." };
  const [u] = await query<{ telegram_chat_id: string | null; quiet_hours_start: string | null; quiet_hours_end: string | null; timezone: string }>(
    `SELECT telegram_chat_id, quiet_hours_start::text, quiet_hours_end::text, timezone FROM users WHERE id = $1`,
    [n.user_id],
  );
  if (!u?.telegram_chat_id) return { outcome: "suppressed", error: "Telegram was disconnected." };
  // During quiet hours Telegram messages still arrive, but without a sound.
  const silent = quietHoursEnd(new Date(), u.quiet_hours_start, u.quiet_hours_end, u.timezone) !== null && !isUrgentKey(n.event_key);
  const r = await telegram(cfg.telegram, "sendMessage", alertMessage(u.telegram_chat_id, n, cfg.appUrl, silent));
  if (r.ok) return { outcome: "sent", error: null };
  if (r.status === 403) {
    // She blocked or deleted the bot: stop trying until it's connected again.
    await query(`UPDATE users SET telegram_chat_id = NULL WHERE id = $1 AND telegram_chat_id = $2`, [n.user_id, u.telegram_chat_id]);
    return { outcome: "failed", error: "Telegram says the bot was blocked. Connect Telegram again in Settings." };
  }
  if (isPermanentTelegramFailure(r.status)) return { outcome: "failed", error: `Telegram refused it: ${r.description}` };
  return {
    outcome: "retry",
    error: `Telegram: ${r.description}`,
    retryAt: r.retryAfter ? new Date(Date.now() + Math.min(r.retryAfter, 3600) * 1000) : undefined,
  };
}

async function sendPushes(cfg: AlertConfig, n: Outgoing): Promise<SendResult> {
  const subs = await query<{ id: string; endpoint: string; keys: PushSubscriptionKeys; server_key: string | null }>(
    `SELECT id, endpoint, keys, server_key FROM push_subscriptions WHERE user_id = $1`,
    [n.user_id],
  );
  if (subs.length === 0) return { outcome: "suppressed", error: "Phone notifications are off." };
  const payload = { title: n.title, body: n.body ?? "", url: n.url ?? "/", tag: n.event_key };
  let delivered = 0;
  let transient = 0;
  for (const s of subs) {
    if (s.server_key !== cfg.push.keys.publicKey || !isAllowedPushEndpoint(s.endpoint, cfg.push.extraOrigins)) {
      await query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
      continue;
    }
    try {
      const r = await sendPush(s.endpoint, s.keys, payload, cfg.push.keys, cfg.push.subject, { urgent: isUrgentKey(n.event_key) });
      if (r.ok) {
        delivered++;
        await query(`UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1`, [s.id]);
      } else if (r.gone) {
        await query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
      } else {
        transient++;
        await query(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, [s.id]);
      }
    } catch {
      transient++;
    }
  }
  if (delivered > 0) return { outcome: "sent", error: null };
  if (transient > 0) return { outcome: "retry", error: "The phone's push service didn't accept it; trying again." };
  return { outcome: "suppressed", error: "Phone notifications were turned off on that device." };
}

/** One full alerts pass for the scheduled run. */
export async function runAlerts(cfg: AlertConfig, deadline: number): Promise<AlertReport> {
  const now = new Date();
  const client = await getPool().connect();
  let created = 0;
  try {
    await client.query("BEGIN");
    const people = await loadPeople(client, cfg.admins);
    const events = await collectEvents(client, now);
    created = await recordNotifications(client, events, people, cfg, now);
    await client.query(`DELETE FROM telegram_updates WHERE received_at < now() - interval '7 days'`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const { sent, failed } = await deliverNotifications(cfg, deadline);
  const [w] = await query<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE status = 'pending'`);
  return { created, sent, failed, waiting: Number(w?.n ?? 0) };
}
