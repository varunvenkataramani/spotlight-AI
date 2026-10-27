// Google sends the admin back here. Every check must pass before a session is created.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode, readWebConfig } from "@/lib/config.ts";
import { isAllowedAdmin } from "@/lib/allowlist.ts";
import { exchangeCodeForIdentity, SignInError, type OAuthStart } from "@/lib/google-oidc.ts";
import { safeNextPath } from "@/lib/oauth/oauth.ts";
import { readSignedValue } from "@/lib/signed-value.ts";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH } from "@/server/oauth-cookie.ts";
import { createSessionToken, sessionCookieName, sessionCookieOptions } from "@/server/session.ts";
import { recordAdminLogin } from "@/server/users.ts";

export const dynamic = "force-dynamic";

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const fail = (code: string) => {
    const response = NextResponse.redirect(new URL(`/login?error=${code}`, request.url));
    response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return response;
  };

  if (isDemoMode()) return NextResponse.redirect(new URL("/login", request.url));
  let config;
  try {
    config = readWebConfig();
  } catch {
    return fail("config");
  }

  if (url.searchParams.get("error")) return fail("access_denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const start = readSignedValue<OAuthStart>(request.cookies.get(OAUTH_COOKIE)?.value, config.sessionSecret);

  if (!code || !state || !start || !sameString(state, start.state)) return fail("state_mismatch");

  try {
    const identity = await exchangeCodeForIdentity({
      code,
      codeVerifier: start.codeVerifier,
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: `${config.appUrl}/api/auth/callback`,
    });

    if (!isAllowedAdmin(identity.email, config.admins)) return fail("not_allowed");

    const userId = await recordAdminLogin(identity);
    // Back to where sign-in started (for example "Allow Claude"), or the overview.
    const response = NextResponse.redirect(new URL(safeNextPath(start.next) ?? "/", config.appUrl));
    response.cookies.set(
      sessionCookieName(config.isProduction),
      createSessionToken({ userId, email: identity.email, name: identity.name }, config.sessionSecret),
      sessionCookieOptions(config.isProduction),
    );
    response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return response;
  } catch (error) {
    if (error instanceof SignInError) return fail(error.code);
    console.error("Sign-in failed:", error instanceof Error ? error.message : "unknown error");
    return fail("unknown");
  }
}
