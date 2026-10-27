// Called every minute by Supabase's scheduler (pg_cron + pg_net) with
// "Authorization: Bearer <CRON_SECRET>". Runs the background work; refuses anyone else.
import { NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/bearer.ts";
import { runTick } from "@/lib/scheduler.ts";
import { demoNotFound } from "@/server/demo.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  // The demo reads no mail and sends no alerts: its data is a fixed, made-up set.
  const blocked = demoNotFound();
  if (blocked) return blocked;
  if (!isAuthorizedBearer(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runTick();
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Scheduled run failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ ran: false, reason: "failed" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
