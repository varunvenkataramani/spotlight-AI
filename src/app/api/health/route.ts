// Public uptime check: reports only up/down states, never data or error details.
import { NextResponse } from "next/server";
import { getInboxHealth } from "@/server/gmail.ts";
import { getSystemHealth } from "@/server/health.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getSystemHealth();
  const ok = health.database === "ok" && health.scheduler === "ok";
  // Just the state word (ok / expiring / stalled / needs_reconnect / none): no address, no times.
  const inbox = health.database === "ok" ? await getInboxHealth().then((i) => i?.health.state ?? "none").catch(() => "unknown") : "unknown";
  return NextResponse.json(
    { ok, database: health.database, scheduler: health.scheduler, inbox, checkedAt: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
