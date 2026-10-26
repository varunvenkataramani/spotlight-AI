// Scheduled background work. Supabase's scheduler (pg_cron) calls /api/cron/tick every
// minute, and that route calls runTick(). Framework-free so it can also be run from a script.
//
// Milestone 1: records that the scheduler is alive.
// Milestone 2 adds Gmail sync and watch renewal; 3 the AI pipeline; 5 alerts and reminders.
import { getPool } from "./db.ts";

const TICK_LOCK_ID = 727_002; // unique to the scheduler; migrations use 727_001
export const SCHEDULER_ID = "scheduler";

export type TickResult = {
  ran: boolean;
  reason?: string;
  tasks: Record<string, "ok" | "skipped" | "failed">;
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
    const tasks: TickResult["tasks"] = {};
    try {
      await client.query(
        `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at, info)
         VALUES ($1, now(), now(), '{}'::jsonb)
         ON CONFLICT (worker_id) DO UPDATE SET last_beat_at = now()`,
        [SCHEDULER_ID],
      );
      tasks.heartbeat = "ok";
      return { ran: true, tasks, durationMs: Date.now() - started };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [TICK_LOCK_ID]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
