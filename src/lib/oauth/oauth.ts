// Spotlight as a small OAuth 2.1 server for the Claude connector: plain helpers with no database,
// so they can be unit-tested. Only Claude's callback addresses may receive codes.
import crypto from "node:crypto";

export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
export const SCOPE = "spotlight";
export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_DAYS = 60;
export const CODE_SECONDS = 300;

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

/** The connector's address, the one admins paste into Claude, and the audience of every token. */
export const mcpResource = (appUrl: string) => `${appUrl}/api/mcp`;

export function protectedResourceMetadata(appUrl: string) {
  return {
    resource: mcpResource(appUrl),
    authorization_servers: [appUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Spotlight",
  };
}

export function authorizationServerMetadata(appUrl: string) {
  return {
    issuer: appUrl,
    authorization_endpoint: `${appUrl}/oauth/authorize`,
    token_endpoint: `${appUrl}/api/oauth/token`,
    registration_endpoint: `${appUrl}/api/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function wwwAuthenticate(appUrl: string, error?: "invalid_token"): string {
  return `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource", scope="${SCOPE}"${error ? `, error="${error}"` : ""}`;
}

// --- Secrets and hashes ----------------------------------------------------------------------------------

export const newSecret = (prefix = "") => `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
export const hashSecret = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** PKCE (S256): the verifier sent with the code must hash to the challenge sent at the start. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return sameSecret(crypto.createHash("sha256").update(verifier).digest("base64url"), challenge);
}

// --- Checks ---------------------------------------------------------------------------------------------------

export function isAllowedRedirect(uri: string, extra: string[] = []): boolean {
  return CLAUDE_REDIRECT_URIS.includes(uri) || extra.includes(uri);
}

/** Resource indicator (RFC 8707): absent (older clients), the connector address, or the site itself. */
export function resourceMatches(raw: unknown, appUrl: string): boolean {
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw !== "string") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.search) return false;
  const normal = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  return normal === mcpResource(appUrl).toLowerCase() || normal === appUrl.toLowerCase();
}

export type Registration = { redirectUris: string[]; clientName: string; authMethod: "none" | "client_secret_post" | "client_secret_basic" };

/** Dynamic client registration (RFC 7591): only what Spotlight needs, and only Claude's callbacks. */
export function parseRegistration(body: unknown, extraRedirects: string[] = []): Registration {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Send the registration as a JSON object.");
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must list one to five addresses.");
  }
  const bad = (uris as string[]).find((u) => !isAllowedRedirect(u, extraRedirects));
  if (bad !== undefined) throw new OAuthError("invalid_redirect_uri", "Spotlight only connects to Claude. That callback address isn't Claude's.");
  const method = b.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  }
  const grants = b.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token"))) {
    throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  }
  const responses = b.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || !responses.every((r) => r === "code"))) {
    throw new OAuthError("invalid_client_metadata", "Only the code response type is supported.");
  }
  const name = typeof b.client_name === "string" ? b.client_name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100) : "";
  return { redirectUris: [...new Set(uris as string[])], clientName: name || "Unnamed app", authMethod: method };
}

/** Client credentials from an Authorization: Basic header, if any. */
export function parseBasicAuth(header: string | null): { id: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  try {
    return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  } catch {
    return null;
  }
}

/** A same-site path to return to after signing in (for example the "Allow Claude" page). */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4000) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\u0000-\u001f\\]/.test(raw)) return null;
  try {
    const u = new URL(raw, "http://spotlight.invalid");
    return u.origin === "http://spotlight.invalid" ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

export type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
  scope: string | null;
};

/**
 * Checks an authorization request. Problems with the client or callback are shown on the page
 * (never redirected, so a bad link can't bounce someone elsewhere); other problems go back to Claude.
 */
export function parseAuthorizeParams(get: (k: string) => string | null): { params: AuthorizeParams; error: null } | { params: Partial<AuthorizeParams>; error: { code: string; description: string; redirectable: boolean } } {
  const clientId = get("client_id") ?? "";
  const redirectUri = get("redirect_uri") ?? "";
  const partial = { clientId, redirectUri, state: get("state"), resource: get("resource"), scope: get("scope") };
  if (!clientId || clientId.length > 200) return { params: partial, error: { code: "invalid_client", description: "The link is missing which app is asking.", redirectable: false } };
  if (!redirectUri) return { params: partial, error: { code: "invalid_request", description: "The link is missing where to return.", redirectable: false } };
  const fail = (code: string, description: string) => ({ params: partial, error: { code, description, redirectable: true } });
  if (get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = get("code_challenge") ?? "";
  if (get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "PKCE with S256 is required.");
  const state = partial.state;
  if (state !== null && state.length > 1000) return fail("invalid_request", "state is too long.");
  return { params: { ...partial, codeChallenge: challenge }, error: null };
}

/** Where to send the browser back to Claude, with the code or an error. */
export function callbackUrl(redirectUri: string, values: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(values)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}
