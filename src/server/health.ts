import { query } from "@/lib/db.ts";

/** The worker writes a heartbeat every minute; three missed beats means it is down. */
export const WORKER_STALE_AFTER_MS = 3 * 60_000;

export type SystemHealth = {
  database: "ok" | "error";
  worker: "ok" | "stale" | "never_seen" | "unknown";
  workerLastBeatAt: Date | null;
  databaseError?: string;
};

export async function getSystemHealth(now = Date.now()): Promise<SystemHealth> {
  try {
    const rows = await query<{ last_beat_at: Date }>(
      `SELECT last_beat_at FROM worker_heartbeats ORDER BY last_beat_at DESC LIMIT 1`,
    );
    const last = rows[0]?.last_beat_at ?? null;
    return {
      database: "ok",
      worker: !last ? "never_seen" : now - last.getTime() <= WORKER_STALE_AFTER_MS ? "ok" : "stale",
      workerLastBeatAt: last,
    };
  } catch (error) {
    return {
      database: "error",
      worker: "unknown",
      workerLastBeatAt: null,
      databaseError: error instanceof Error ? error.message : "unknown error",
    };
  }
}
