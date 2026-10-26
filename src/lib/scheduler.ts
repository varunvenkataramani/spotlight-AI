// Scheduled background work. Supabase's scheduler (pg_cron) calls /api/cron/tick every
// minute, and that route calls runTick(). Framework-free so it can also be run from a script.
//
// Each run: Gmail sync, then AI sorting, then alerts and reminders (Telegram, phones, in-app).
import { ConfigError, readAiConfig, readAlertConfig, readGmailConfig } from "./config.ts";
import { getPool, query } from "./db.ts";
import { anthropicBaseUrl } from "./ai/anthropic.ts";
import { processPendingEmails, type AiReport } from "./ai/process.ts";
import { runAlerts, type AlertReport } from "./alerts/engine.ts";
import { googleEndpoints } from "./gmail/google.ts";
import { syncAllInboxes } from "./gmail/sync.ts";

const TICK_LOCK_ID = 727_002; // unique to the scheduler; migrations use 727_001
export const SCHEDULER_ID = "scheduler";
/** Gmail sync stops starting new work after this long, leaving the rest of the run for AI sorting. */
export const GMAIL_BUDGET_MS = 20_000;
/** AI sorting stops starting new emails after this long, leaving time for alerts. */
export const TICK_BUDGET_MS = 40_000;
/** Alerts stop sending after this long, well inside the 60-second function limit. */
export const ALERT_BUDGET_MS = 50_000;

export type AiStatus = { state: "ok" | "off" | "account_problem" | "failed"; message: string | null; at: string };

export type TickResult = {
  ran: boolean;
  reason?: string;
  tasks: Record<string, "ok" | "skipped" | "failed">;
  gmail?: { inboxes: number; queuedNew: number; queuedScan: number; fetched: number; failed: number; reconnectNeeded: number };
  ai?: AiReport;
  alerts?: AlertReport;
  durationMs: number;
};

export async function runTick(): Promise<TickResult> {
  const started = Date.now();
  const client = await getPool().connect();
  let inTransaction = false;
  try {
    // Ticks can overlap if one runs long; only one may work at a time. The lock is tied to a
    // transaction held open on this connection for the whole run, so it also works through
    // Supabase's transaction pooler (session-level locks would leak there).
    await client.query("BEGIN");
    inTransaction = true;
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [TICK_LOCK_ID]);
    if (!lock.rows[0]?.locked) {
      return { ran: false, reason: "previous run still in progress", tasks: {}, durationMs: Date.now() - started };
    }
    const result: TickResult = { ran: true, tasks: {}, durationMs: 0 };
    // The heartbeat commits on its own, so Settings sees the run straight away.
    await query(
      `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at, info)
       VALUES ($1, now(), now(), '{}'::jsonb)
       ON CONFLICT (worker_id) DO UPDATE SET last_beat_at = now()`,
      [SCHEDULER_ID],
    );
    result.tasks.heartbeat = "ok";

    // 1. Gmail
    try {
      const config = readGmailConfig();
      const reports = await syncAllInboxes({ ...config, endpoints: googleEndpoints(), deadline: started + GMAIL_BUDGET_MS });
      const sum = (k: "queuedNew" | "queuedScan" | "fetched" | "failed") => reports.reduce((n, r) => n + r[k], 0);
      result.gmail = {
        inboxes: reports.length,
        queuedNew: sum("queuedNew"),
        queuedScan: sum("queuedScan"),
        fetched: sum("fetched"),
        failed: sum("failed"),
        reconnectNeeded: reports.filter((r) => r.status === "reconnect_needed").length,
      };
      result.tasks.gmail = reports.some((r) => r.status === "failed") ? "failed" : "ok";
    } catch (error) {
      result.tasks.gmail = error instanceof ConfigError ? "skipped" : "failed";
      if (!(error instanceof ConfigError)) console.error("Gmail sync failed:", error instanceof Error ? error.message : "unknown error");
    }

    // 2. AI sorting
    let ai: AiStatus;
    try {
      const config = readAiConfig();
      result.ai = await processPendingEmails({ ...config, baseUrl: anthropicBaseUrl(), deadline: started + TICK_BUDGET_MS });
      result.tasks.ai = result.ai.accountProblem ? "failed" : "ok";
      ai = result.ai.accountProblem
        ? { state: "account_problem", message: result.ai.accountProblem, at: new Date().toISOString() }
        : { state: "ok", message: null, at: new Date().toISOString() };
    } catch (error) {
      const off = error instanceof ConfigError;
      result.tasks.ai = off ? "skipped" : "failed";
      if (!off) console.error("AI sorting failed:", error instanceof Error ? error.message : "unknown error");
      ai = off
        ? { state: "off", message: "Add ANTHROPIC_API_KEY in Vercel to turn on AI sorting.", at: new Date().toISOString() }
        : { state: "failed", message: "The last sorting run failed; it will try again next minute.", at: new Date().toISOString() };
    }
    await query(`UPDATE worker_heartbeats SET info = jsonb_set(info, '{ai}', $2::jsonb) WHERE worker_id = $1`, [
      SCHEDULER_ID,
      JSON.stringify(ai),
    ]);

    // 3. Alerts and reminders: worked out after sorting, so a new offer is announced in the same run.
    try {
      result.alerts = await runAlerts(readAlertConfig(), started + ALERT_BUDGET_MS);
      result.tasks.alerts = "ok";
    } catch (error) {
      result.tasks.alerts = error instanceof ConfigError ? "skipped" : "failed";
      if (!(error instanceof ConfigError)) console.error("Alerts failed:", error instanceof Error ? error.message : "unknown error");
    }

    result.durationMs = Date.now() - started;
    return result;
  } finally {
    // Ending the transaction releases the lock. If that fails, discard the connection rather than reuse it.
    let broken = false;
    if (inTransaction) await client.query("COMMIT").catch(() => (broken = true));
    client.release(broken);
  }
}
