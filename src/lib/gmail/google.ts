// Gmail connection: consent URL, code exchange, token refresh and revoke.
// Fetch is injectable and Google's addresses can point at a fake server in tests.
import { codeChallengeFor, identityFromIdToken, type GoogleIdentity } from "../google-oidc.ts";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose"; // same as compose.ts

export type GoogleEndpoints = { auth: string; token: string; revoke: string; gmail: string };

const REAL_ENDPOINTS: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  gmail: "https://gmail.googleapis.com/gmail/v1",
};

/** Tests may point Google calls at a fake server. Never honoured on a Vercel production deploy. */
export function googleEndpoints(env: NodeJS.ProcessEnv = process.env): GoogleEndpoints {
  const base = env.GOOGLE_API_BASE_OVERRIDE?.replace(/\/+$/, "");
  if (!base || env.VERCEL_ENV === "production") return REAL_ENDPOINTS;
  return { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, gmail: `${base}/gmail/v1` };
}

export class GmailConnectError extends Error {
  readonly code: "token_exchange_failed" | "no_refresh_token" | "scope_not_granted";
  constructor(code: GmailConnectError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** The refresh token no longer works (expired, revoked or password changed): an admin must reconnect. */
export class ReconnectRequiredError extends Error {}

export function buildGmailConnectUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  loginHint?: string;
  /** Also ask to save drafts and send replies (gmail.compose). Earlier permissions are kept. */
  allowSend?: boolean;
  endpoints?: GoogleEndpoints;
}): string {
  const url = new URL((params.endpoints ?? REAL_ENDPOINTS).auth);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${GMAIL_READONLY_SCOPE}${params.allowSend ? ` ${GMAIL_COMPOSE_SCOPE}` : ""}`);
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // always returns a refresh token
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", codeChallengeFor(params.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

export type GmailGrant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  identity: GoogleIdentity;
};

export async function exchangeGmailCode(
  params: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string },
  endpoints: GoogleEndpoints = REAL_ENDPOINTS,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<GmailGrant> {
  const response = await fetchImpl(endpoints.token, {
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
  if (!response.ok) throw new GmailConnectError("token_exchange_failed", `Google answered ${response.status}`);
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!body.access_token || !body.id_token) {
    throw new GmailConnectError("token_exchange_failed", "Google's answer was incomplete");
  }
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  // The consent screen lets people untick permissions; Spotlight can't work without read access.
  if (!scopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new GmailConnectError("scope_not_granted", "Permission to read email was not granted");
  }
  if (!body.refresh_token) throw new GmailConnectError("no_refresh_token", "Google returned no refresh token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(now + (body.expires_in ?? 3600) * 1000),
    scopes,
    identity: identityFromIdToken(body.id_token, params.clientId, now),
  };
}

export async function refreshAccessToken(
  params: { refreshToken: string; clientId: string; clientSecret: string },
  endpoints: GoogleEndpoints = REAL_ENDPOINTS,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ accessToken: string; expiresAt: Date }> {
  const response = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant" || response.status === 401) {
      throw new ReconnectRequiredError("Google no longer accepts Spotlight's access to this inbox");
    }
  }
  if (!response.ok) throw new Error(`Token refresh failed with status ${response.status}`);
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Token refresh returned no access token");
  return { accessToken: body.access_token, expiresAt: new Date(now + (body.expires_in ?? 3600) * 1000) };
}

/** Best effort: a token that is already invalid counts as revoked. */
export async function revokeToken(
  token: string,
  endpoints: GoogleEndpoints = REAL_ENDPOINTS,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(endpoints.revoke, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}
