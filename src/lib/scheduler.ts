// Scheduled background work. Supabase's scheduler (pg_cron) calls /api/cron/tick every
// minute, and that route calls runTick(). Framework-free so it can also be run from a script.
//
// Milestone 2: Gmail sync. Milestone 3 adds the AI pipeline; 5 alerts and reminders.
import { ConfigError, readGmailConfig } from "./config.ts";
import { getPool } from "./db.ts";
import { googleEndpoints } from "./gmail/google.ts";
import { syncAllInboxes } from "./gmail/sync.ts";

const TICK_LOCK_ID = 727_002; // unique to the scheduler; migrations use 727_001
export const SCHEDULER_ID = "scheduler";
/** Stop starting new work after this long, well inside the 60-second function limit. */
export const TICK_BUDGET_MS = 45_000;

export type TickResult = {
  ran: boolean;
  reason?: string;
  tasks: Record<string, "ok" | "skipped" | "failed">;
  gmail?: { inboxes: number; queuedNew: number; queuedScan: number; fetched: number; failed: number; reconnectNeeded: number };
  durationMs: number;
};

export async function runTick(): Promise<TickResult> {
  const started = Date.now();
  const client = await getPool().connect();
  try {
    // Ticks can overlap if one runs long; only one may work at a time.
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [TICK_LOCK_ID]);
    if (!lock.rows[0]?.locked) {
      return { ran: false, reason: "previous run still in progress", tasks: {}, durationMs: Date.now() - started };
    }
    const result: TickResult = { ran: true, tasks: {}, durationMs: 0 };
    try {
      await client.query(
        `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at, info)
         VALUES ($1, now(), now(), '{}'::jsonb)
         ON CONFLICT (worker_id) DO UPDATE SET last_beat_at = now()`,
        [SCHEDULER_ID],
      );
      result.tasks.heartbeat = "ok";

      try {
        const config = readGmailConfig();
        const reports = await syncAllInboxes({
          ...config,
          endpoints: googleEndpoints(),
          deadline: started + TICK_BUDGET_MS,
        });
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
        if (!(error instanceof ConfigError)) {
          console.error("Gmail sync failed:", error instanceof Error ? error.message : "unknown error");
        }
      }

      result.durationMs = Date.now() - started;
      return result;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [TICK_LOCK_ID]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
