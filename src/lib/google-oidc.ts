// "Sign in with Google" using the OAuth 2.0 authorization-code flow with PKCE.
// No SDK: the flow is small, and keeping it here makes every check visible and testable.
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** `next`: a same-site page to return to after signing in (for example "Allow Claude"). */
export type OAuthStart = { state: string; codeVerifier: string; next?: string };

export function createOAuthStart(): OAuthStart {
  return {
    state: randomBytes(24).toString("base64url"),
    codeVerifier: randomBytes(48).toString("base64url"),
  };
}

export function codeChallengeFor(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function buildSignInUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", codeChallengeFor(params.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

export type GoogleIdentity = { email: string; name: string | null; picture: string | null; subject: string };

export class SignInError extends Error {
  readonly code: "token_exchange_failed" | "invalid_id_token" | "email_not_verified";
  constructor(code: SignInError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Checks the claims of an ID token received directly from Google's token endpoint over TLS.
 * OpenID Connect Core 3.1.3.7 allows TLS server validation in place of a signature check
 * for tokens obtained this way; issuer, audience, expiry and email verification are still checked.
 */
export function identityFromIdToken(idToken: string, clientId: string, now = Date.now()): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new SignInError("invalid_id_token", "ID token is malformed");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new SignInError("invalid_id_token", "ID token payload is not JSON");
  }
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
    throw new SignInError("invalid_id_token", "ID token issuer is not Google");
  }
  const aud = claims.aud;
  if (aud !== clientId && !(Array.isArray(aud) && aud.includes(clientId))) {
    throw new SignInError("invalid_id_token", "ID token was issued for a different app");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
    throw new SignInError("invalid_id_token", "ID token has expired");
  }
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") {
    throw new SignInError("invalid_id_token", "ID token has no email");
  }
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new SignInError("email_not_verified", "Google has not verified this email address");
  }
  return {
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    subject: claims.sub,
  };
}

export async function exchangeCodeForIdentity(
  params: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleIdentity> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new SignInError("token_exchange_failed", `Google token endpoint answered ${response.status}`);
  }
  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") {
    throw new SignInError("token_exchange_failed", "Google returned no ID token");
  }
  return identityFromIdToken(body.id_token, params.clientId);
}
