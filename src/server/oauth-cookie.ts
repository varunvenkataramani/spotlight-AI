// Short-lived cookie that carries the OAuth state and PKCE verifier between
// the start of Google sign-in and Google's redirect back.
export const OAUTH_COOKIE = "spotlight_oauth";
export const OAUTH_COOKIE_PATH = "/api/auth";
export const OAUTH_TTL_SECONDS = 600;
