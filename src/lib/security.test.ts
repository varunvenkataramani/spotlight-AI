import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./token-crypto.ts";
import { createSignedValue, readSignedValue } from "./signed-value.ts";
import { isAllowedAdmin, parseAllowlist } from "./allowlist.ts";
import { isAuthorizedBearer } from "./bearer.ts";
import { describeDatabaseUrl } from "./database-url.ts";
import {
  buildSignInUrl,
  codeChallengeFor,
  createOAuthStart,
  exchangeCodeForIdentity,
  identityFromIdToken,
  SignInError,
} from "./google-oidc.ts";

const SECRET = "a".repeat(40);
const CLIENT_ID = "client-123.apps.googleusercontent.com";

function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}
const validClaims = () => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 600,
  sub: "1234",
  email: "Manager@Example.com",
  email_verified: true,
  name: "Manager",
});

// --- Token encryption -------------------------------------------------------

test("encrypted tokens decrypt back to the original", () => {
  const key = randomBytes(32);
  const sealed = encryptSecret("ya29.refresh-token", key);
  assert.notEqual(sealed, "ya29.refresh-token");
  assert.equal(decryptSecret(sealed, key), "ya29.refresh-token");
});

test("each encryption uses a fresh IV", () => {
  const key = randomBytes(32);
  assert.notEqual(encryptSecret("same", key), encryptSecret("same", key));
});

test("tampered ciphertext is rejected", () => {
  const key = randomBytes(32);
  const parts = encryptSecret("secret", key).split(".");
  parts[3] = Buffer.from("evil").toString("base64url");
  assert.throws(() => decryptSecret(parts.join("."), key));
});

test("a different key cannot decrypt", () => {
  const sealed = encryptSecret("secret", randomBytes(32));
  assert.throws(() => decryptSecret(sealed, randomBytes(32)));
});

test("encryption key must be 32 bytes", () => {
  assert.throws(() => parseEncryptionKey(undefined), /not set/);
  assert.throws(() => parseEncryptionKey(randomBytes(16).toString("base64")), /32 bytes/);
  assert.equal(parseEncryptionKey(randomBytes(32).toString("base64")).length, 32);
});

// --- Signed cookies ---------------------------------------------------------

test("signed values round-trip", () => {
  const token = createSignedValue({ email: "a@x.com" }, 60, SECRET);
  assert.deepEqual(readSignedValue(token, SECRET), { email: "a@x.com" });
});

test("a modified payload is rejected", () => {
  const token = createSignedValue({ email: "a@x.com" }, 60, SECRET);
  const [, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: { email: "attacker@x.com" }, exp: 9999999999 })).toString("base64url");
  assert.equal(readSignedValue(`${forged}.${sig}`, SECRET), null);
});

test("a value signed with another secret is rejected", () => {
  const token = createSignedValue({ ok: true }, 60, "b".repeat(40));
  assert.equal(readSignedValue(token, SECRET), null);
});

test("expired values are rejected", () => {
  const token = createSignedValue({ ok: true }, 60, SECRET, Date.now() - 120_000);
  assert.equal(readSignedValue(token, SECRET), null);
});

test("garbage tokens are rejected without throwing", () => {
  for (const t of [undefined, null, "", "nodot", ".sig", "abc.def", "%%%.###"]) {
    assert.equal(readSignedValue(t, SECRET), null);
  }
});

// --- Admin allow-list --------------------------------------------------------

test("allow-list ignores case, spaces and junk entries", () => {
  const list = parseAllowlist(" Manager@Example.com , actress@example.com,,notanemail ");
  assert.equal(list.size, 2);
  assert.ok(isAllowedAdmin("manager@example.com", list));
  assert.ok(isAllowedAdmin("ACTRESS@example.com", list));
  assert.ok(!isAllowedAdmin("stranger@example.com", list));
  assert.ok(!isAllowedAdmin(undefined, list));
  assert.ok(!isAllowedAdmin("anyone@x.com", parseAllowlist(undefined)));
});

// --- Database address diagnostics ---------------------------------------------

test("database address diagnostics never print the password", () => {
  const out = describeDatabaseUrl("postgresql://postgres.abc:SuperSecret123@aws-0.pooler.supabase.com:5432/postgres");
  assert.ok(!out.includes("SuperSecret123"));
  assert.match(out, /user "postgres\.abc"/);
  assert.match(out, /password 14 characters/);
  assert.match(out, /well formed/);
});

test("database address diagnostics catch common paste mistakes", () => {
  const host = "aws-0.pooler.supabase.com";
  assert.match(describeDatabaseUrl(`postgresql://postgres.abc:[YOUR-PASSWORD]@${host}:5432/postgres`), /placeholder/);
  assert.match(describeDatabaseUrl(`postgresql://postgres.abc:[pw123]@${host}:5432/postgres`), /square brackets/);
  assert.match(describeDatabaseUrl(`postgresql://postgres.abc:pw@${host}:6543/postgres`), /6543/);
  assert.match(describeDatabaseUrl(`postgresql://postgres:pw@${host}:5432/postgres`), /postgres\.<project-ref>/);
  assert.match(describeDatabaseUrl(`"postgresql://postgres.abc:pw@${host}:5432/postgres"`), /quotes/);
  assert.match(describeDatabaseUrl("not a url"), /not a valid address/);
});

// --- Scheduler secret ----------------------------------------------------------

test("scheduler calls need the exact bearer secret", () => {
  const secret = "s".repeat(40);
  assert.ok(isAuthorizedBearer(`Bearer ${secret}`, secret));
  assert.ok(!isAuthorizedBearer(`Bearer ${secret}x`, secret));
  assert.ok(!isAuthorizedBearer(`bearer ${secret}`, secret));
  assert.ok(!isAuthorizedBearer(secret, secret));
  assert.ok(!isAuthorizedBearer(null, secret));
});

test("a missing or short scheduler secret refuses every call", () => {
  assert.ok(!isAuthorizedBearer("Bearer ", undefined));
  assert.ok(!isAuthorizedBearer("Bearer ", ""));
  assert.ok(!isAuthorizedBearer("Bearer short", "short"));
});

// --- Google sign-in ------------------------------------------------------------

test("sign-in URL carries PKCE, state and minimal scopes", () => {
  const start = createOAuthStart();
  const url = new URL(
    buildSignInUrl({ clientId: CLIENT_ID, redirectUri: "https://app/api/auth/callback", ...start }),
  );
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), start.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), codeChallengeFor(start.codeVerifier));
  assert.ok(!url.toString().includes(start.codeVerifier), "verifier must never leave the server");
});

test("PKCE challenge matches the RFC 7636 test vector", () => {
  assert.equal(
    codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("a valid ID token yields a lowercase identity", () => {
  const id = identityFromIdToken(fakeIdToken(validClaims()), CLIENT_ID);
  assert.equal(id.email, "manager@example.com");
  assert.equal(id.name, "Manager");
});

test("ID tokens with bad claims are rejected", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ iss: "https://evil.example" }, "invalid_id_token"],
    [{ aud: "another-app" }, "invalid_id_token"],
    [{ exp: Math.floor(Date.now() / 1000) - 10 }, "invalid_id_token"],
    [{ email: undefined }, "invalid_id_token"],
    [{ email_verified: false }, "email_not_verified"],
  ];
  for (const [override, code] of cases) {
    assert.throws(
      () => identityFromIdToken(fakeIdToken({ ...validClaims(), ...override }), CLIENT_ID),
      (e: unknown) => e instanceof SignInError && e.code === code,
      JSON.stringify(override),
    );
  }
  assert.throws(() => identityFromIdToken("not.a-token", CLIENT_ID), SignInError);
});

test("code exchange sends the verifier and reads the ID token", async () => {
  let sentBody = "";
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    sentBody = String(init?.body);
    return new Response(JSON.stringify({ id_token: fakeIdToken(validClaims()) }), { status: 200 });
  }) as typeof fetch;
  const id = await exchangeCodeForIdentity(
    { code: "c", codeVerifier: "v123", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://app/cb" },
    fakeFetch,
  );
  assert.equal(id.email, "manager@example.com");
  assert.match(sentBody, /code_verifier=v123/);
  assert.match(sentBody, /grant_type=authorization_code/);
});

test("a failed code exchange surfaces a clear error", async () => {
  const fakeFetch = (async () => new Response("{}", { status: 400 })) as typeof fetch;
  await assert.rejects(
    exchangeCodeForIdentity(
      { code: "c", codeVerifier: "v", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://app/cb" },
      fakeFetch,
    ),
    (e: unknown) => e instanceof SignInError && e.code === "token_exchange_failed",
  );
});
