// Starts "Sign in with Google": remembers state + PKCE verifier in a short-lived signed cookie.
import { NextResponse } from "next/server";
import { ConfigError, readWebConfig } from "@/lib/config.ts";
import { buildSignInUrl, createOAuthStart } from "@/lib/google-oidc.ts";
import { safeNextPath } from "@/lib/oauth/oauth.ts";
import { createSignedValue } from "@/lib/signed-value.ts";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, OAUTH_TTL_SECONDS } from "@/server/oauth-cookie.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let config;
  try {
    config = readWebConfig();
  } catch (error) {
    const reason = error instanceof ConfigError ? "config" : "unknown";
    return NextResponse.redirect(new URL(`/login?error=${reason}`, request.url));
  }

  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  const start = { ...createOAuthStart(), ...(next ? { next } : {}) };
  const response = NextResponse.redirect(
    buildSignInUrl({
      clientId: config.googleClientId,
      redirectUri: `${config.appUrl}/api/auth/callback`,
      state: start.state,
      codeVerifier: start.codeVerifier,
    }),
  );
  response.cookies.set(OAUTH_COOKIE, createSignedValue(start, OAUTH_TTL_SECONDS, config.sessionSecret), {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_TTL_SECONDS,
  });
  return response;
}
