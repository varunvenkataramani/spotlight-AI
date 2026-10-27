// The demo's front door: enter as Kabir (her manager) or Tara (the actress), no Google needed.
// Only exists when DEMO_MODE=on. Also used to switch view or reset the demo's made-up data.
import { NextResponse } from "next/server";
import { readWebConfig } from "@/lib/config.ts";
import { enterDemo, isDemoMode } from "@/server/demo.ts";
import { isCrossSite } from "@/server/request-guard.ts";
import { createSessionToken, sessionCookieName, sessionCookieOptions } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isDemoMode()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (isCrossSite(request)) return NextResponse.json({ error: "cross_site" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const as = form.get("as") === "talent" ? "talent" : "manager";
  const reset = form.get("reset") === "1";

  try {
    const config = readWebConfig();
    const session = await enterDemo(as, reset);
    const done = reset ? "?done=The+demo+is+back+to+its+starting+offers." : "";
    const response = NextResponse.redirect(new URL(`/${done}`, config.appUrl), 303);
    response.cookies.set(sessionCookieName(config.isProduction), createSessionToken(session, config.sessionSecret), sessionCookieOptions(config.isProduction));
    return response;
  } catch (error) {
    console.error("Demo entry failed:", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return NextResponse.redirect(new URL("/login?error=demo", request.url), 303);
  }
}
