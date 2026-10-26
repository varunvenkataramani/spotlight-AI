// Google sends the admin back here after the Gmail consent screen.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { readGmailConfig, readWebConfig } from "@/lib/config.ts";
import { getProfile } from "@/lib/gmail/api.ts";
import { exchangeGmailCode, GmailConnectError, googleEndpoints } from "@/lib/gmail/google.ts";
import { SignInError } from "@/lib/google-oidc.ts";
import { readSignedValue } from "@/lib/signed-value.ts";
import { saveConnectedInbox } from "@/server/gmail.ts";
import { GMAIL_COOKIE, GMAIL_COOKIE_PATH, type GmailConnectState } from "@/server/gmail-cookie.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  const finish = (outcome: string) => {
    const response = NextResponse.redirect(new URL(`/settings?gmail=${outcome}`, request.url));
    response.cookies.set(GMAIL_COOKIE, "", { path: GMAIL_COOKIE_PATH, maxAge: 0 });
    return response;
  };

  let web, gmail;
  try {
    web = readWebConfig();
    gmail = readGmailConfig();
  } catch {
    return finish("config");
  }

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return finish("access_denied");
  const code = params.get("code");
  const stateParam = params.get("state");
  const saved = readSignedValue<GmailConnectState>(request.cookies.get(GMAIL_COOKIE)?.value, web.sessionSecret);
  if (!code || !stateParam || !saved || !sameString(stateParam, saved.state) || saved.userId !== admin.userId) {
    return finish("state_mismatch");
  }

  try {
    const endpoints = googleEndpoints();
    const grant = await exchangeGmailCode(
      {
        code,
        codeVerifier: saved.codeVerifier,
        clientId: web.googleClientId,
        clientSecret: web.googleClientSecret,
        redirectUri: `${web.appUrl}/api/gmail/callback`,
      },
      endpoints,
    );
    const profile = await getProfile({ accessToken: grant.accessToken, baseUrl: endpoints.gmail });
    if (profile.emailAddress.toLowerCase() !== grant.identity.email) return finish("account_mismatch");

    const outcome = await saveConnectedInbox({
      grant,
      historyId: profile.historyId,
      scanDays: saved.scanDays,
      adminUserId: admin.userId,
      tokenKey: gmail.tokenKey,
    });
    if (!outcome.ok) return finish("other_inbox_connected");
    return finish(outcome.reconnected ? "reconnected" : "connected");
  } catch (error) {
    if (error instanceof GmailConnectError || error instanceof SignInError) {
      console.warn(`Gmail connect refused (${error.code}): ${error.message}`);
      return finish(error instanceof GmailConnectError ? error.code : "token_exchange_failed");
    }
    console.error("Gmail connect failed:", error instanceof Error ? error.message : "unknown error");
    return finish("unknown");
  }
}
