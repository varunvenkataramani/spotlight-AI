// Turning phone and browser notifications on or off for the signed-in admin (called by the Settings page).
import { NextResponse, type NextRequest } from "next/server";
import { EditError } from "@/lib/edits.ts";
import { removePushSubscription, savePushSubscription } from "@/server/alerts.ts";
import { isDemoMode } from "@/server/demo.ts";
import { isCrossSite } from "@/server/request-guard.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (isCrossSite(request)) return NextResponse.json({ error: "cross_site" }, { status: 403 });
  if (isDemoMode()) return NextResponse.json({ error: "Phone notifications aren't available in the demo." }, { status: 400 });
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Send JSON." }, { status: 415 });
  }
  const body = (await request.json().catch(() => null)) as { action?: string; subscription?: unknown; endpoint?: unknown } | null;
  try {
    if (body?.action === "subscribe") {
      await savePushSubscription(admin, body.subscription, request.headers.get("user-agent"));
      return NextResponse.json({ ok: true, message: "Notifications are on for this device." });
    }
    if (body?.action === "unsubscribe") {
      await removePushSubscription(admin, body.endpoint);
      return NextResponse.json({ ok: true, message: "Notifications are off for this device." });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof EditError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Push subscription change failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
