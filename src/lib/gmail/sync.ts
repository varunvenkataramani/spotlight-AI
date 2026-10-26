// Gmail sync, run from the scheduler every minute. Each run, per connected inbox:
//   1. new mail: read Gmail's change history since the last run and queue new inbox messages;
//   2. first scan: list one more page of past inbox mail (within the chosen number of days);
//   3. fetch: download queued messages (new mail first), parse and store them.
// Everything is idempotent: re-running a step can never store a message twice.
import { getPool, query } from "../db.ts";
import { decryptSecret, encryptSecret } from "../token-crypto.ts";
import {
  getMessage,
  getProfile,
  GmailApiError,
  inboxAdditions,
  listHistory,
  listMessages,
  type GmailContext,
} from "./api.ts";
import { ReconnectRequiredError, refreshAccessToken, type GoogleEndpoints } from "./google.ts";
import { parseGmailMessage, type ParsedEmail } from "./parse.ts";

export const MAX_FETCH_ATTEMPTS = 5;
const FETCH_BATCH = 30;
const FETCH_CONCURRENCY = 6;
const SCAN_PAGE_SIZE = 100;

export type SyncDeps = {
  tokenKey: Buffer;
  clientId: string;
  clientSecret: string;
  endpoints: GoogleEndpoints;
  /** Epoch ms by which this run must stop starting new work. */
  deadline: number;
  fetchImpl?: typeof fetch;
};

export type SyncReport = {
  status: "ok" | "reconnect_needed" | "failed";
  queuedNew: number;
  queuedScan: number;
  fetched: number;
  failed: number;
  error?: string;
};

type AccountRow = {
  id: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires_at: Date | null;
  history_id: string | null;
  scan_after: Date | null;
  scan_page_token: string | null;
  initial_scan_completed_at: Date | null;
  last_synced_at: Date | null;
  connected_at: Date;
};

const msLeft = (deps: SyncDeps) => deps.deadline - Date.now();

/** Keeps error text short and free of anything but the error itself. */
function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

export async function syncAllInboxes(deps: SyncDeps): Promise<SyncReport[]> {
  const accounts = await query<AccountRow>(
    `SELECT id, refresh_token_enc, access_token_enc, access_token_expires_at, history_id, scan_after,
            scan_page_token, initial_scan_completed_at, last_synced_at, connected_at
     FROM gmail_accounts WHERE status = 'connected'`,
  );
  const reports: SyncReport[] = [];
  for (const account of accounts) {
    if (msLeft(deps) < 10_000) break;
    reports.push(await syncInbox(account, deps));
  }
  return reports;
}

async function syncInbox(account: AccountRow, deps: SyncDeps): Promise<SyncReport> {
  const report: SyncReport = { status: "ok", queuedNew: 0, queuedScan: 0, fetched: 0, failed: 0 };
  try {
    const ctx: GmailContext = {
      accessToken: await ensureAccessToken(account, deps),
      baseUrl: deps.endpoints.gmail,
      fetchImpl: deps.fetchImpl,
    };

    if (account.history_id) {
      report.queuedNew = await pullNewMail(account, ctx, deps);
    } else {
      const profile = await getProfile(ctx);
      await query(`UPDATE gmail_accounts SET history_id = $2 WHERE id = $1`, [account.id, profile.historyId]);
    }

    if (!account.initial_scan_completed_at && msLeft(deps) > 15_000) {
      report.queuedScan = await listScanPage(account, ctx);
    }

    const fetched = await fetchQueued(account.id, ctx, deps);
    report.fetched = fetched.fetched;
    report.failed = fetched.failed;

    await query(
      `UPDATE gmail_accounts SET last_synced_at = now(), last_error = NULL, consecutive_failures = 0 WHERE id = $1`,
      [account.id],
    );
    return report;
  } catch (error) {
    if (error instanceof ReconnectRequiredError) {
      await query(
        `UPDATE gmail_accounts
         SET status = 'needs_reconnect', access_token_enc = NULL, access_token_expires_at = NULL,
             last_error = 'Google stopped accepting Spotlight''s access. Reconnect Gmail in Settings.', last_error_at = now()
         WHERE id = $1`,
        [account.id],
      );
      return { ...report, status: "reconnect_needed", error: "reconnect needed" };
    }
    await query(
      `UPDATE gmail_accounts
       SET last_error = $2, last_error_at = now(), consecutive_failures = consecutive_failures + 1
       WHERE id = $1`,
      [account.id, safeError(error)],
    );
    return { ...report, status: "failed", error: safeError(error) };
  }
}

async function ensureAccessToken(account: AccountRow, deps: SyncDeps): Promise<string> {
  const valid =
    account.access_token_enc && account.access_token_expires_at && account.access_token_expires_at.getTime() > Date.now() + 120_000;
  if (valid) return decryptSecret(account.access_token_enc!, deps.tokenKey);
  if (!account.refresh_token_enc) throw new ReconnectRequiredError("No refresh token stored");
  const refreshed = await refreshAccessToken(
    { refreshToken: decryptSecret(account.refresh_token_enc, deps.tokenKey), clientId: deps.clientId, clientSecret: deps.clientSecret },
    deps.endpoints,
    deps.fetchImpl,
  );
  await query(`UPDATE gmail_accounts SET access_token_enc = $2, access_token_expires_at = $3 WHERE id = $1`, [
    account.id,
    encryptSecret(refreshed.accessToken, deps.tokenKey),
    refreshed.expiresAt,
  ]);
  return refreshed.accessToken;
}

export async function enqueue(
  accountId: string,
  messageIds: string[],
  isHistorical: boolean,
  source: "initial_scan" | "history" | "recovery",
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const result = await getPool().query(
    `INSERT INTO gmail_fetch_queue (gmail_account_id, gmail_message_id, is_historical, source)
     SELECT $1::uuid, m.msg_id, $3::boolean, $4::text FROM unnest($2::text[]) AS m(msg_id)
     WHERE NOT EXISTS (SELECT 1 FROM emails e WHERE e.gmail_account_id = $1::uuid AND e.gmail_message_id = m.msg_id)
     ON CONFLICT DO NOTHING`,
    [accountId, messageIds, isHistorical, source],
  );
  return result.rowCount ?? 0;
}

async function pullNewMail(account: AccountRow, ctx: GmailContext, deps: SyncDeps): Promise<number> {
  let pageToken: string | undefined;
  let latest = account.history_id!;
  let queued = 0;
  do {
    let page;
    try {
      page = await listHistory(ctx, { startHistoryId: account.history_id!, pageToken });
    } catch (error) {
      // Gmail keeps about a week of history; after a long outage start again from "now"
      // and catch up on anything received since the last good sync.
      if (error instanceof GmailApiError && error.status === 404) return recoverMissedMail(account, ctx, deps);
      throw error;
    }
    queued += await enqueue(account.id, inboxAdditions(page), false, "history");
    latest = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken && msLeft(deps) > 10_000);

  // Only move the bookmark once every page was read; otherwise the next run re-reads (harmlessly).
  if (!pageToken) await query(`UPDATE gmail_accounts SET history_id = $2 WHERE id = $1`, [account.id, latest]);
  return queued;
}

async function recoverMissedMail(account: AccountRow, ctx: GmailContext, deps: SyncDeps): Promise<number> {
  const profile = await getProfile(ctx); // new bookmark first, so nothing slips between the two steps
  const since = new Date((account.last_synced_at ?? account.connected_at).getTime() - 24 * 3600_000);
  let pageToken: string | undefined;
  let queued = 0;
  do {
    const page = await listMessages(ctx, { q: `in:inbox after:${Math.floor(since.getTime() / 1000)}`, pageToken });
    queued += await enqueue(account.id, (page.messages ?? []).map((m) => m.id), false, "recovery");
    pageToken = page.nextPageToken;
  } while (pageToken && msLeft(deps) > 10_000);
  await query(`UPDATE gmail_accounts SET history_id = $2 WHERE id = $1`, [account.id, profile.historyId]);
  return queued;
}

async function listScanPage(account: AccountRow, ctx: GmailContext): Promise<number> {
  const after = account.scan_after ?? account.connected_at;
  const page = await listMessages(ctx, {
    q: `in:inbox after:${Math.floor(after.getTime() / 1000)}`,
    pageToken: account.scan_page_token ?? undefined,
    maxResults: SCAN_PAGE_SIZE,
  });
  const ids = (page.messages ?? []).map((m) => m.id);
  const queued = await enqueue(account.id, ids, true, "initial_scan");
  await query(
    `UPDATE gmail_accounts
     SET scan_page_token = $2::text,
         scan_listed = scan_listed + $3,
         initial_scan_completed_at = CASE WHEN $2::text IS NULL THEN now() ELSE NULL END
     WHERE id = $1`,
    [account.id, page.nextPageToken ?? null, ids.length],
  );
  return queued;
}

type QueueRow = { gmail_message_id: string; is_historical: boolean };

async function fetchQueued(accountId: string, ctx: GmailContext, deps: SyncDeps) {
  let fetched = 0;
  let failed = 0;
  while (msLeft(deps) > 8_000) {
    const batch = await query<QueueRow>(
      `SELECT gmail_message_id, is_historical FROM gmail_fetch_queue
       WHERE gmail_account_id = $1 AND attempts < $2 AND not_before <= now()
       ORDER BY is_historical ASC, created_at ASC
       LIMIT $3`,
      [accountId, MAX_FETCH_ATTEMPTS, FETCH_BATCH],
    );
    if (batch.length === 0) break;

    let authFailed = false;
    await runWithConcurrency(batch, FETCH_CONCURRENCY, async (item) => {
      if (authFailed || msLeft(deps) < 5_000) return;
      try {
        const message = await getMessage(ctx, item.gmail_message_id);
        await storeEmail(accountId, parseGmailMessage(message), item.is_historical);
        await dequeue(accountId, item.gmail_message_id);
        fetched++;
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) {
          await dequeue(accountId, item.gmail_message_id); // deleted in Gmail before we read it
          return;
        }
        if (error instanceof GmailApiError && error.status === 401) {
          authFailed = true;
          return;
        }
        failed++;
        await query(
          `UPDATE gmail_fetch_queue
           SET attempts = attempts + 1, last_error = $3,
               not_before = now() + make_interval(mins => power(2, attempts)::int)
           WHERE gmail_account_id = $1 AND gmail_message_id = $2`,
          [accountId, item.gmail_message_id, safeError(error)],
        );
      }
    });
    if (authFailed) {
      // The access token was rejected mid-run: force a refresh on the next run.
      await query(`UPDATE gmail_accounts SET access_token_expires_at = now() WHERE id = $1`, [accountId]);
      throw new Error("Gmail rejected the access token; it will be refreshed on the next run");
    }
  }
  return { fetched, failed };
}

async function dequeue(accountId: string, messageId: string) {
  await query(`DELETE FROM gmail_fetch_queue WHERE gmail_account_id = $1 AND gmail_message_id = $2`, [accountId, messageId]);
}

/** Postgres text cannot hold NUL characters, which occasionally appear in badly encoded mail. */
const clean = (s: string | null) => (s === null ? null : s.replace(/\u0000/g, ""));

export async function storeEmail(accountId: string, email: ParsedEmail, isHistorical: boolean): Promise<void> {
  await query(
    `INSERT INTO emails (
       gmail_account_id, gmail_message_id, gmail_thread_id, rfc_message_id, in_reply_to,
       from_name, from_email, reply_to, to_emails, cc_emails, subject, snippet, body_text,
       received_at, gmail_labels, has_attachments, attachment_names, is_historical, processing_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending')
     ON CONFLICT (gmail_account_id, gmail_message_id) DO NOTHING`,
    [
      accountId,
      email.gmailMessageId,
      email.gmailThreadId,
      clean(email.rfcMessageId),
      clean(email.inReplyTo),
      clean(email.from?.name ?? null),
      clean(email.from?.email ?? null),
      clean(email.replyTo),
      email.to.map((a) => clean(a)!),
      email.cc.map((a) => clean(a)!),
      clean(email.subject),
      clean(email.snippet),
      clean(email.bodyText),
      email.receivedAt,
      email.labels,
      email.hasAttachments,
      email.attachmentNames.map((a) => clean(a)!),
      isHistorical,
    ],
  );
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
