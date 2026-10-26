// Starts connecting (or reconnecting) the inbox: sends the admin to Google's consent screen.
import { NextResponse, type NextRequest } from "next/server";
import { ConfigError, readWebConfig } from "@/lib/config.ts";
import { buildGmailConnectUrl, googleEndpoints } from "@/lib/gmail/google.ts";
import { createOAuthStart } from "@/lib/google-oidc.ts";
import { createSignedValue } from "@/lib/signed-value.ts";
import { normaliseScanDays } from "@/server/gmail.ts";
import { GMAIL_COOKIE, GMAIL_COOKIE_PATH, type GmailConnectState } from "@/server/gmail-cookie.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  let config;
  try {
    config = readWebConfig();
  } catch (error) {
    if (error instanceof ConfigError) return NextResponse.redirect(new URL("/settings?gmail=config", request.url));
    throw error;
  }

  const start = createOAuthStart();
  const state: GmailConnectState = {
    ...start,
    scanDays: normaliseScanDays(request.nextUrl.searchParams.get("scan_days")),
    userId: admin.userId,
  };
  const response = NextResponse.redirect(
    buildGmailConnectUrl({
      clientId: config.googleClientId,
      redirectUri: `${config.appUrl}/api/gmail/callback`,
      state: start.state,
      codeVerifier: start.codeVerifier,
      loginHint: request.nextUrl.searchParams.get("hint") ?? undefined,
      endpoints: googleEndpoints(),
    }),
  );
  response.cookies.set(GMAIL_COOKIE, createSignedValue(state, 600, config.sessionSecret), {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: GMAIL_COOKIE_PATH,
    maxAge: 600,
  });
  return response;
}
