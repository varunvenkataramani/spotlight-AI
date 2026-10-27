// The Claude connector's OAuth server: app registration, the "Allow" step, tokens, and the
// connections list in Settings. Codes and tokens are stored only as SHA-256 hashes.
import type pg from "pg";
import { getPool, query } from "@/lib/db.ts";
import {
  ACCESS_TOKEN_SECONDS,
  CODE_SECONDS,
  callbackUrl,
  isAllowedRedirect,
  parseAuthorizeParams,
  OAuthError,
  REFRESH_TOKEN_DAYS,
  SCOPE,
  hashSecret,
  mcpResource,
  newSecret,
  parseBasicAuth,
  pkceMatches,
  resourceMatches,
  sameSecret,
  type AuthorizeParams,
  type Registration,
} from "@/lib/oauth/oauth.ts";
import type { AdminSession } from "@/server/session.ts";

/** Extra callback addresses allowed besides Claude's: only for automated tests. */
export const extraRedirects = () =>
  (process.env.OAUTH_TEST_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type ClientRow = { id: string; client_id: string; client_secret_hash: string | null; client_name: string; redirect_uris: string[]; token_auth_method: string };

export async function registerClient(reg: Registration) {
  const [recent] = await query<{ n: string }>(`SELECT count(*) AS n FROM oauth_clients WHERE created_at > now() - interval '1 hour'`);
  if (Number(recent?.n ?? 0) >= 30) throw new OAuthError("temporarily_unavailable", "Too many apps registered recently. Try again in an hour.", 429);
  const clientId = newSecret("spc_");
  const secret = reg.authMethod === "none" ? null : newSecret("sps_");
  await query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_auth_method) VALUES ($1, $2, $3, $4, $5)`,
    [clientId, secret ? hashSecret(secret) : null, reg.clientName, reg.redirectUris, reg.authMethod],
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: reg.clientName,
    redirect_uris: reg.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: reg.authMethod,
    scope: SCOPE,
  };
}

export async function findClient(clientId: string): Promise<ClientRow | null> {
  const [c] = await query<ClientRow>(
    `SELECT id, client_id, client_secret_hash, client_name, redirect_uris, token_auth_method FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  return c ?? null;
}

/** "Allow": records the connection and returns a one-time code bound to the PKCE challenge and callback. */
export async function issueCode(admin: AdminSession, client: ClientRow, p: AuthorizeParams, appUrl: string): Promise<string> {
  const code = newSecret("spa_");
  await tx(async (c) => {
    // Connecting Claude again replaces the earlier connection from the same app for this admin.
    await c.query(`UPDATE oauth_grants SET revoked_at = now() WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [client.id, admin.userId]);
    const g = await c.query<{ id: string }>(`INSERT INTO oauth_grants (client_id, user_id, resource) VALUES ($1, $2, $3) RETURNING id`, [
      client.id,
      admin.userId,
      mcpResource(appUrl),
    ]);
    await c.query(
      `INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [hashSecret(code), g.rows[0]!.id, p.redirectUri, p.codeChallenge, CODE_SECONDS],
    );
  });
  return code;
}

/** Client authentication at the token endpoint: public clients send only their id. */
async function authenticateClient(c: pg.PoolClient, form: URLSearchParams, authorization: string | null): Promise<ClientRow> {
  const basic = parseBasicAuth(authorization);
  const clientId = basic?.id ?? form.get("client_id") ?? "";
  const secret = basic?.secret ?? form.get("client_secret");
  const r = await c.query<ClientRow>(
    `SELECT id, client_id, client_secret_hash, client_name, redirect_uris, token_auth_method FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const client = r.rows[0];
  // 401 invalid_client tells Claude to register again (for example after its registration was cleaned up).
  if (!client) throw new OAuthError("invalid_client", "Unknown client. Register again.", 401);
  if (client.client_secret_hash) {
    if (!secret || !sameSecret(hashSecret(secret), client.client_secret_hash)) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
  }
  return client;
}

async function issueTokens(c: pg.PoolClient, grantId: string) {
  const access = newSecret("sla_");
  const refresh = newSecret("slr_");
  await c.query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES
       ($1, $3, 'access', now() + make_interval(secs => $4)),
       ($2, $3, 'refresh', now() + make_interval(days => $5))`,
    [hashSecret(access), hashSecret(refresh), grantId, ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_DAYS],
  );
  await c.query(`UPDATE oauth_grants SET last_used_at = now() WHERE id = $1`, [grantId]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: SCOPE };
}

type GrantRow = { grant_id: string; client_id: string; revoked_at: Date | null; email: string };

export async function exchangeToken(form: URLSearchParams, authorization: string | null, appUrl: string, admins: Set<string>) {
  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  if (!resourceMatches(form.get("resource"), appUrl)) throw new OAuthError("invalid_target", "Tokens are only issued for Spotlight's connector.");

  // Some refusals also end the connection; those must be saved, so they're returned, not thrown.
  const outcome = await tx(async (c): Promise<{ tokens: Awaited<ReturnType<typeof issueTokens>> } | { refuse: OAuthError }> => {
    const client = await authenticateClient(c, form, authorization);
    const invalid = (why: string) => new OAuthError("invalid_grant", why);

    if (grantType === "authorization_code") {
      const r = await c.query<GrantRow & { redirect_uri: string; code_challenge: string; expires_at: Date; used_at: Date | null }>(
        `SELECT k.redirect_uri, k.code_challenge, k.expires_at, k.used_at, g.id AS grant_id, g.client_id, g.revoked_at, u.email
         FROM oauth_codes k JOIN oauth_grants g ON g.id = k.grant_id JOIN users u ON u.id = g.user_id
         WHERE k.code_hash = $1 FOR UPDATE OF k`,
        [hashSecret(form.get("code") ?? "")],
      );
      const k = r.rows[0];
      if (!k) throw invalid("Unknown or expired code.");
      if (k.used_at) {
        // A code used twice may have been stolen: end that connection.
        await c.query(`UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [k.grant_id]);
        return { refuse: invalid("This code was already used.") };
      }
      if (k.expires_at.getTime() < Date.now() || k.revoked_at) throw invalid("Unknown or expired code.");
      if (k.client_id !== client.id) throw invalid("This code belongs to another app.");
      if (form.get("redirect_uri") !== k.redirect_uri) throw invalid("redirect_uri doesn't match the one used to ask.");
      if (!pkceMatches(form.get("code_verifier"), k.code_challenge)) throw invalid("PKCE check failed.");
      if (!admins.has(k.email)) throw invalid("That account is no longer an admin.");
      await c.query(`UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1`, [hashSecret(form.get("code") ?? "")]);
      await c.query(`UPDATE oauth_clients SET last_used_at = now() WHERE id = $1`, [client.id]);
      return { tokens: await issueTokens(c, k.grant_id) };
    }

    const r = await c.query<GrantRow & { token_hash: string; expires_at: Date; token_revoked_at: Date | null }>(
      `SELECT t.token_hash, t.expires_at, t.revoked_at AS token_revoked_at, g.id AS grant_id, g.client_id, g.revoked_at, u.email
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
       WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
      [hashSecret(form.get("refresh_token") ?? "")],
    );
    const t = r.rows[0];
    if (!t) throw invalid("Unknown refresh token.");
    if (t.client_id !== client.id) throw invalid("This token belongs to another app.");
    if (t.token_revoked_at) {
      // An old refresh token coming back long after it was replaced suggests a copy: end the connection.
      // (A quick repeat, for example two requests at once, is just refused.)
      if (Date.now() - t.token_revoked_at.getTime() > 60_000) {
        await c.query(`UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [t.grant_id]);
      }
      return { refuse: invalid("This refresh token was already used.") };
    }
    if (t.revoked_at || t.expires_at.getTime() < Date.now()) throw invalid("The connection ended. Connect Claude again.");
    if (!admins.has(t.email)) throw invalid("That account is no longer an admin.");
    await c.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1`, [t.token_hash]);
    return { tokens: await issueTokens(c, t.grant_id) };
  });
  if ("refuse" in outcome) throw outcome.refuse;
  return outcome.tokens;
}

/** The admin behind a connector request, or null if the token isn't valid for Spotlight's connector right now. */
export async function adminForAccessToken(token: string, admins: Set<string>, appUrl: string): Promise<AdminSession | null> {
  const [r] = await query<{ user_id: string; email: string; name: string | null; grant_id: string; resource: string; last_used_at: Date | null }>(
    `SELECT u.id AS user_id, u.email, u.name, g.id AS grant_id, g.resource, g.last_used_at
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND g.revoked_at IS NULL`,
    [hashSecret(token)],
  );
  if (!r || !admins.has(r.email) || r.resource !== mcpResource(appUrl)) return null;
  if (!r.last_used_at || Date.now() - r.last_used_at.getTime() > 5 * 60_000) {
    await query(`UPDATE oauth_grants SET last_used_at = now() WHERE id = $1`, [r.grant_id]);
  }
  return { userId: r.user_id, email: r.email, name: r.name };
}

// --- Settings ------------------------------------------------------------------------------------------------

export type Connection = { id: string; client_name: string; created_at: Date; last_used_at: Date | null };

export async function listConnections(userId: string): Promise<Connection[]> {
  return query<Connection>(
    `SELECT g.id, c.client_name, g.created_at, g.last_used_at FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
    [userId],
  );
}

export async function revokeConnection(userId: string, grantId: unknown): Promise<boolean> {
  if (typeof grantId !== "string" || !/^[0-9a-f-]{36}$/i.test(grantId)) return false;
  const rows = await query(`UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [grantId, userId]);
  if (rows.length) await query(`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL`, [grantId]);
  return rows.length > 0;
}

export type AuthorizeCheck =
  | { kind: "show_error"; message: string }
  | { kind: "redirect"; url: string }
  | { kind: "ok"; client: ClientRow; params: AuthorizeParams };

/**
 * Validates an authorization request (from the "Allow" page's link or its form). Only a known app
 * with one of its own registered callbacks is ever redirected to; anything else is shown on the page.
 */
export async function checkAuthorize(get: (k: string) => string | null, appUrl: string): Promise<AuthorizeCheck> {
  const parsed = parseAuthorizeParams(get);
  const p = parsed.params;
  const client = p.clientId ? await findClient(p.clientId) : null;
  if (!client) return { kind: "show_error", message: "This link isn't from an app Spotlight knows. Start connecting again from Claude." };
  if (!p.redirectUri || !client.redirect_uris.includes(p.redirectUri) || !isAllowedRedirect(p.redirectUri, extraRedirects())) {
    return { kind: "show_error", message: "This link would send you somewhere other than Claude, so it was stopped. Start connecting again from Claude." };
  }
  const back = (error: string, description: string) => ({
    kind: "redirect" as const,
    url: callbackUrl(p.redirectUri!, { error, error_description: description, state: p.state ?? null, iss: appUrl }),
  });
  if (parsed.error) return back(parsed.error.code, parsed.error.description);
  if (!resourceMatches(p.resource, appUrl)) return back("invalid_target", "Spotlight can only authorize its own connector.");
  if (p.scope && !p.scope.split(" ").every((s) => s === SCOPE || s === "")) return back("invalid_scope", `The only scope is ${SCOPE}.`);
  return { kind: "ok", client, params: parsed.params };
}
