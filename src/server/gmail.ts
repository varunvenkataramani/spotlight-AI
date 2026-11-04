// Connecting, reconnecting and disconnecting the inbox, and its status for the screens.
import { canCompose } from "@/lib/gmail/compose.ts";
import { EditError } from "@/lib/edits.ts";
import { inboxHealth, type InboxHealth, type InboxHealthInput } from "@/lib/gmail/health.ts";
import { query } from "@/lib/db.ts";
import { MAX_FETCH_ATTEMPTS } from "@/lib/gmail/sync.ts";
import { encryptSecret } from "@/lib/token-crypto.ts";
import type { GmailGrant } from "@/lib/gmail/google.ts";

export const SCAN_DAY_CHOICES = [7, 14, 30, 90, 180, 365] as const;
export const DEFAULT_SCAN_DAYS = 14;

export function normaliseScanDays(raw: unknown): number {
  const n = Number(raw);
  return (SCAN_DAY_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_SCAN_DAYS;
}

type ExistingInbox = { id: string; email: string; history_id: string | null };

export type ConnectOutcome = { ok: true; reconnected: boolean } | { ok: false; reason: "other_inbox_connected" };

export async function saveConnectedInbox(params: {
  grant: GmailGrant;
  historyId: string;
  scanDays: number;
  adminUserId: string;
  tokenKey: Buffer;
}): Promise<ConnectOutcome> {
  const { grant, tokenKey } = params;
  const email = grant.identity.email;
  const existing = (await query<ExistingInbox>(`SELECT id, email, history_id FROM gmail_accounts LIMIT 1`))[0];

  if (existing && existing.email !== email) return { ok: false, reason: "other_inbox_connected" };

  const refreshEnc = encryptSecret(grant.refreshToken, tokenKey);
  const accessEnc = encryptSecret(grant.accessToken, tokenKey);

  if (existing) {
    // Reconnect: keep the history bookmark so sync resumes exactly where it stopped.
    await query(
      `UPDATE gmail_accounts
       SET status = 'connected', refresh_token_enc = $2, access_token_enc = $3, access_token_expires_at = $4,
           scopes = $5, google_subject = $6, history_id = COALESCE(history_id, $7),
           last_error = NULL, last_error_at = NULL, consecutive_failures = 0, authorized_at = now()
       WHERE id = $1`,
      [existing.id, refreshEnc, accessEnc, grant.expiresAt, grant.scopes, grant.identity.subject, params.historyId],
    );
  } else {
    await query(
      `INSERT INTO gmail_accounts
         (email, status, refresh_token_enc, access_token_enc, access_token_expires_at, scopes, google_subject,
          history_id, scan_days, scan_after, connected_by)
       VALUES ($1, 'connected', $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $8), $9)`,
      [email, refreshEnc, accessEnc, grant.expiresAt, grant.scopes, grant.identity.subject, params.historyId, params.scanDays, params.adminUserId],
    );
  }
  await query(
    `INSERT INTO activities (actor_type, actor_user_id, kind, detail) VALUES ('user', $1, $2, $3)`,
    [params.adminUserId, existing ? "gmail_reconnected" : "gmail_connected", JSON.stringify({ email, scanDays: params.scanDays })],
  );
  return { ok: true, reconnected: Boolean(existing) };
}

export type DisconnectTarget = { id: string; email: string; refresh_token_enc: string | null };

export async function getInboxForDisconnect(): Promise<DisconnectTarget | null> {
  return (await query<DisconnectTarget>(`SELECT id, email, refresh_token_enc FROM gmail_accounts LIMIT 1`))[0] ?? null;
}

/** Deletes the inbox and, through the database's cascade rules, every email and opportunity from it. */
export async function deleteInboxAndData(target: DisconnectTarget, adminUserId: string): Promise<number> {
  const counted = await query<{ n: string }>(`SELECT count(*) AS n FROM emails WHERE gmail_account_id = $1`, [target.id]);
  const deletedEmails = Number(counted[0]?.n ?? 0);
  await query(`DELETE FROM gmail_accounts WHERE id = $1`, [target.id]);
  // Alerts about that inbox go too (offer alerts already went with their offers).
  await query(`DELETE FROM notifications WHERE event_key LIKE ANY($1::text[])`, [[`gmail_reconnect:${target.id}:%`, `gmail_stalled:${target.id}:%`]]);
  await query(`INSERT INTO activities (actor_type, actor_user_id, kind, detail) VALUES ('user', $1, 'gmail_disconnected', $2)`, [
    adminUserId,
    JSON.stringify({ email: target.email, deletedEmails }),
  ]);
  return deletedEmails;
}

export type InboxStatus = {
  email: string;
  status: "connected" | "needs_reconnect" | "revoked" | "error" | "disconnected";
  connectedAt: Date;
  lastSyncedAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  scanDays: number;
  scanListed: number;
  scanListingDone: boolean;
  storedTotal: number;
  storedEarlier: number;
  storedNew: number;
  waiting: number;
  stuck: number;
  /** Allowed to save drafts and send replies (gmail.compose). */
  canReply: boolean;
  /** Also reads the Spam folder; and whether the one-off read of recent spam is still going. */
  includeSpam: boolean;
  spamScanPending: boolean;
};

export async function getInboxStatus(): Promise<InboxStatus | null> {
  const rows = await query<{
    id: string;
    email: string;
    status: InboxStatus["status"];
    scopes: string[];
    connected_at: Date;
    last_synced_at: Date | null;
    last_error: string | null;
    consecutive_failures: number;
    scan_days: number;
    scan_listed: number;
    initial_scan_completed_at: Date | null;
    include_spam: boolean;
    spam_scan_pending: boolean;
    stored_total: string;
    stored_earlier: string;
    waiting: string;
    stuck: string;
  }>(
    `SELECT a.id, a.email, a.status, a.scopes, a.connected_at, a.last_synced_at, a.last_error, a.consecutive_failures,
            a.scan_days, a.scan_listed, a.initial_scan_completed_at, a.include_spam, a.spam_scan_pending,
            (SELECT count(*) FROM emails e WHERE e.gmail_account_id = a.id) AS stored_total,
            (SELECT count(*) FROM emails e WHERE e.gmail_account_id = a.id AND e.is_historical) AS stored_earlier,
            (SELECT count(*) FROM gmail_fetch_queue q WHERE q.gmail_account_id = a.id AND q.attempts < $1) AS waiting,
            (SELECT count(*) FROM gmail_fetch_queue q WHERE q.gmail_account_id = a.id AND q.attempts >= $1) AS stuck
     FROM gmail_accounts a LIMIT 1`,
    [MAX_FETCH_ATTEMPTS],
  );
  const r = rows[0];
  if (!r) return null;
  const storedTotal = Number(r.stored_total);
  const storedEarlier = Number(r.stored_earlier);
  return {
    email: r.email,
    status: r.status,
    connectedAt: r.connected_at,
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    scanDays: r.scan_days,
    scanListed: r.scan_listed,
    scanListingDone: r.initial_scan_completed_at !== null,
    storedTotal,
    storedEarlier,
    storedNew: storedTotal - storedEarlier,
    waiting: Number(r.waiting),
    stuck: Number(r.stuck),
    canReply: canCompose(r.scopes),
    includeSpam: r.include_spam,
    spamScanPending: r.spam_scan_pending,
  };
}

/** For the banner on every page: is the inbox being read, and if not, what to do. One small query. */
export async function getInboxHealth(): Promise<{ email: string; canReply: boolean; health: InboxHealth } | null> {
  const rows = await query<InboxHealthInput & { email: string; scopes: string[] }>(
    `SELECT email, status, scopes, last_synced_at, consecutive_failures, authorized_at, connected_at
     FROM gmail_accounts WHERE status <> 'disconnected' LIMIT 1`,
  );
  const r = rows[0];
  return r ? { email: r.email, canReply: canCompose(r.scopes), health: inboxHealth(r) } : null;
}

/** Turns reading the Spam folder on or off. Turning it on also reads the last 30 days of spam once. */
export async function setSpamReading(adminUserId: string, on: boolean): Promise<string> {
  const rows = await query<{ email: string }>(
    `UPDATE gmail_accounts
     SET include_spam = $1,
         spam_scan_pending = CASE WHEN $1 AND NOT include_spam THEN true WHEN $1 THEN spam_scan_pending ELSE false END,
         spam_scan_page_token = CASE WHEN $1 AND include_spam THEN spam_scan_page_token END
     WHERE status <> 'disconnected' RETURNING email`,
    [on],
  );
  if (!rows[0]) throw new EditError("Connect Gmail first.");
  await query(`INSERT INTO activities (actor_type, actor_user_id, kind, detail) VALUES ('user', $1, 'gmail_spam_setting', $2)`, [
    adminUserId,
    JSON.stringify({ on }),
  ]);
  return on
    ? "Spotlight now reads the Spam folder too. The last 30 days of spam are being read; anything Gmail put in Spam is marked so you check it first."
    : "Spotlight no longer reads the Spam folder. Emails it already read from Spam stay where they are.";
}

export type SyncedEmailRow = {
  id: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: Date;
  is_historical: boolean;
  has_attachments: boolean;
  processing_state: string;
  classification: string | null;
};

export async function listSyncedEmails(limit = 50): Promise<SyncedEmailRow[]> {
  return query<SyncedEmailRow>(
    `SELECT id, from_name, from_email, subject, snippet, received_at, is_historical, has_attachments,
            processing_state, classification
     FROM emails ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
}
