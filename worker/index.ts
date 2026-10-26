// Spotlight background worker: runs all the time, independent of the dashboard.
// Milestone 1: proves it is alive with a heartbeat the dashboard can see.
// Milestone 2 adds Gmail sync jobs; Milestone 3 the AI pipeline; Milestone 5 alerts and reminders.
import { hostname } from "node:os";
import { closePool, query } from "../src/lib/db.ts";

const WORKER_ID = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const HEARTBEAT_MS = 60_000;
const startedAt = new Date();
let stopping = false;
let timer: NodeJS.Timeout | undefined;

function log(message: string) {
  console.log(`${new Date().toISOString()} [worker] ${message}`);
}

async function heartbeat() {
  await query(
    `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at, info)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (worker_id) DO UPDATE SET last_beat_at = now(), info = EXCLUDED.info`,
    [WORKER_ID, startedAt, JSON.stringify({ node: process.version, uptimeSeconds: Math.round(process.uptime()) })],
  );
  // Each deploy gets a new worker id; forget ones that have been silent for a week.
  await query(`DELETE FROM worker_heartbeats WHERE last_beat_at < now() - interval '7 days'`);
}

async function tick() {
  if (stopping) return;
  try {
    await heartbeat();
  } catch (error) {
    // Never crash on a transient database error; the next tick retries.
    log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stopping) timer = setTimeout(tick, HEARTBEAT_MS);
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  log(`${signal} received, shutting down`);
  await closePool().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log(`starting as ${WORKER_ID}`);
void tick();
