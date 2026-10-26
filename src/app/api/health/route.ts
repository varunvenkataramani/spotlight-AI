// Public uptime check: reports only up/down states, never data or error details.
import { NextResponse } from "next/server";
import { getSystemHealth } from "@/server/health.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getSystemHealth();
  const ok = health.database === "ok" && health.scheduler === "ok";
  return NextResponse.json(
    { ok, database: health.database, scheduler: health.scheduler, checkedAt: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
