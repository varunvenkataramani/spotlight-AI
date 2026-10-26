import { query } from "@/lib/db.ts";
import { SCHEDULER_ID } from "@/lib/scheduler.ts";

/** The scheduler runs every minute; three missed runs means it has stopped. */
export const SCHEDULER_STALE_AFTER_MS = 3 * 60_000;

export type SystemHealth = {
  database: "ok" | "error";
  scheduler: "ok" | "stale" | "never_seen" | "unknown";
  schedulerLastRunAt: Date | null;
  databaseError?: string;
};

export async function getSystemHealth(now = Date.now()): Promise<SystemHealth> {
  try {
    const rows = await query<{ last_beat_at: Date }>(
      `SELECT last_beat_at FROM worker_heartbeats WHERE worker_id = $1`,
      [SCHEDULER_ID],
    );
    const last = rows[0]?.last_beat_at ?? null;
    return {
      database: "ok",
      scheduler: !last ? "never_seen" : now - last.getTime() <= SCHEDULER_STALE_AFTER_MS ? "ok" : "stale",
      schedulerLastRunAt: last,
    };
  } catch (error) {
    return {
      database: "error",
      scheduler: "unknown",
      schedulerLastRunAt: null,
      databaseError: error instanceof Error ? error.message : "unknown error",
    };
  }
}
