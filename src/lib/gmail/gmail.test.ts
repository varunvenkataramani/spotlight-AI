import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeMimeWords,
  htmlToText,
  MAX_BODY_CHARS,
  parseAddress,
  parseAddressList,
  parseGmailMessage,
  type GmailMessage,
} from "./parse.ts";
import {
  buildGmailConnectUrl,
  exchangeGmailCode,
  GMAIL_READONLY_SCOPE,
  GmailConnectError,
  googleEndpoints,
  ReconnectRequiredError,
  refreshAccessToken,
} from "./google.ts";
import { GmailApiError, inboxAdditions, listHistory } from "./api.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const CLIENT_ID = "client-123.apps.googleusercontent.com";

function idToken(email = "Varun@Example.com") {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "42",
    email,
    email_verified: true,
  })}.sig`;
}

// --- Parsing --------------------------------------------------------------------

test("plain-text email: headers, body and dates are extracted", () => {
  const msg: GmailMessage = {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hi Ananya, we&#39;d love to collaborate",
    internalDate: "1793000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: '"Priya Shah, Glow Labs" <Priya@GlowLabs.in>' },
        { name: "To", value: "ananya@gmail.com, Manager <mgr@agency.in>" },
        { name: "Subject", value: "Paid reel collaboration" },
        { name: "Message-ID", value: "<abc@glowlabs.in>" },
        { name: "Content-Type", value: 'text/plain; charset="UTF-8"' },
      ],
      body: { data: b64("Budget ₹75,000 for 1 reel + 2 stories.\r\nReply by 30 Oct.") },
    },
  };
  const p = parseGmailMessage(msg);
  assert.deepEqual(p.from, { name: "Priya Shah, Glow Labs", email: "priya@glowlabs.in" });
  assert.deepEqual(p.to, ["ananya@gmail.com", "mgr@agency.in"]);
  assert.equal(p.subject, "Paid reel collaboration");
  assert.equal(p.bodyText, "Budget ₹75,000 for 1 reel + 2 stories.\nReply by 30 Oct.");
  assert.equal(p.snippet, "Hi Ananya, we'd love to collaborate");
  assert.equal(p.receivedAt.getTime(), 1793000000000);
  assert.equal(p.rfcMessageId, "<abc@glowlabs.in>");
  assert.equal(p.hasAttachments, false);
});

test("multipart email prefers the plain part and notes attachments", () => {
  const p = parseGmailMessage({
    id: "m2",
    threadId: "t2",
    internalDate: "1793000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "casting@studio.com" }],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Audition on 4 Nov in Andheri.") } },
            { mimeType: "text/html", body: { data: b64("<p>Audition on <b>4 Nov</b></p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "Casting brief.pdf", body: { attachmentId: "att1", size: 2048 } },
      ],
    },
  });
  assert.equal(p.bodyText, "Audition on 4 Nov in Andheri.");
  assert.equal(p.hasAttachments, true);
  assert.deepEqual(p.attachmentNames, ["Casting brief.pdf"]);
  assert.deepEqual(p.from, { name: null, email: "casting@studio.com" });
});

test("HTML-only email becomes readable text with link addresses kept", () => {
  const html = `<html><head><style>p{color:red}</style></head><body>
    <h1>Launch event</h1><p>Dear Ananya,&nbsp;you&#39;re invited&hellip;</p>
    <ul><li>Date: 12 Nov</li><li>Fee: &#8377;1,50,000</li></ul>
    <p>Brief: <a href="https://brand.in/brief.pdf">download</a><br>Thanks</p>
    <script>track()</script></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /^Launch event\n+Dear Ananya, you're invited…/);
  assert.match(text, /- Date: 12 Nov\n- Fee: ₹1,50,000/);
  assert.match(text, /Brief: download \(https:\/\/brand\.in\/brief\.pdf\)\nThanks/);
  assert.ok(!text.includes("color:red") && !text.includes("track()"));
});

test("encoded headers and non-UTF-8 bodies are decoded", () => {
  assert.equal(decodeMimeWords("=?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWH?="), "नमस्ते");
  assert.equal(decodeMimeWords("=?ISO-8859-1?Q?Caf=E9_shoot?="), "Café shoot");
  assert.equal(decodeMimeWords("=?UTF-8?Q?Hello?= =?UTF-8?Q?_World?="), "Hello World");
  const p = parseGmailMessage({
    id: "m3",
    threadId: "t3",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
      body: { data: Buffer.from([0x43, 0x61, 0x66, 0xe9]).toString("base64url") },
    },
  });
  assert.equal(p.bodyText, "Café");
});

test("address parsing handles quotes, bare addresses and junk", () => {
  assert.deepEqual(parseAddress("Rahul <RAHUL@x.com>"), { name: "Rahul", email: "rahul@x.com" });
  assert.deepEqual(parseAddress("rahul@x.com"), { name: null, email: "rahul@x.com" });
  assert.equal(parseAddress("undisclosed-recipients:;"), null);
  assert.deepEqual(parseAddressList('"Doe, Jane" <j@x.com>, k@y.com'), ["j@x.com", "k@y.com"]);
});

test("very long bodies are shortened with a marker", () => {
  const p = parseGmailMessage({
    id: "m4",
    threadId: "t4",
    payload: { mimeType: "text/plain", body: { data: b64("a".repeat(MAX_BODY_CHARS + 50)) } },
  });
  assert.ok(p.bodyText.length < MAX_BODY_CHARS + 100);
  assert.match(p.bodyText, /\[Message shortened by Spotlight\]$/);
});

// --- Google connection -------------------------------------------------------------

test("consent URL asks only for read access, offline, with PKCE", () => {
  const url = new URL(
    buildGmailConnectUrl({ clientId: CLIENT_ID, redirectUri: "https://app/api/gmail/callback", state: "s", codeVerifier: "v" }),
  );
  assert.equal(url.searchParams.get("scope"), `openid email ${GMAIL_READONLY_SCOPE}`);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!url.toString().includes("gmail.send") && !url.toString().includes("gmail.modify"));
});

test("test override of Google addresses is ignored on production deploys", () => {
  assert.equal(googleEndpoints({ GOOGLE_API_BASE_OVERRIDE: "http://localhost:4010" } as never).token, "http://localhost:4010/token");
  assert.equal(
    googleEndpoints({ GOOGLE_API_BASE_OVERRIDE: "http://evil", VERCEL_ENV: "production" } as never).token,
    "https://oauth2.googleapis.com/token",
  );
  assert.equal(googleEndpoints({} as never).gmail, "https://gmail.googleapis.com/gmail/v1");
});

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}
const exchangeParams = { code: "c", codeVerifier: "v", clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://app/cb" };

test("code exchange returns tokens and the inbox owner", async () => {
  const grant = await exchangeGmailCode(
    exchangeParams,
    undefined,
    tokenResponse({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: `openid ${GMAIL_READONLY_SCOPE} email`, id_token: idToken() }),
  );
  assert.equal(grant.refreshToken, "rt");
  assert.equal(grant.identity.email, "varun@example.com");
  assert.ok(grant.expiresAt.getTime() > Date.now() + 3_500_000);
});

test("code exchange refuses when read permission was unticked or no refresh token came back", async () => {
  await assert.rejects(
    exchangeGmailCode(exchangeParams, undefined, tokenResponse({ access_token: "at", refresh_token: "rt", scope: "openid email", id_token: idToken() })),
    (e: unknown) => e instanceof GmailConnectError && e.code === "scope_not_granted",
  );
  await assert.rejects(
    exchangeGmailCode(exchangeParams, undefined, tokenResponse({ access_token: "at", scope: GMAIL_READONLY_SCOPE, id_token: idToken() })),
    (e: unknown) => e instanceof GmailConnectError && e.code === "no_refresh_token",
  );
  await assert.rejects(
    exchangeGmailCode(exchangeParams, undefined, tokenResponse({}, 400)),
    (e: unknown) => e instanceof GmailConnectError && e.code === "token_exchange_failed",
  );
});

test("token refresh: success, revoked access, and Google outages are told apart", async () => {
  const p = { refreshToken: "rt", clientId: CLIENT_ID, clientSecret: "s" };
  const ok = await refreshAccessToken(p, undefined, tokenResponse({ access_token: "new", expires_in: 3600 }));
  assert.equal(ok.accessToken, "new");
  await assert.rejects(refreshAccessToken(p, undefined, tokenResponse({ error: "invalid_grant" }, 400)), ReconnectRequiredError);
  await assert.rejects(refreshAccessToken(p, undefined, tokenResponse({}, 503)), (e: unknown) => !(e instanceof ReconnectRequiredError));
});

// --- Gmail API --------------------------------------------------------------------

test("history additions keep inbox mail only, without duplicates", () => {
  const ids = inboxAdditions({
    historyId: "200",
    history: [
      { messagesAdded: [{ message: { id: "a", threadId: "t", labelIds: ["INBOX", "UNREAD"] } }] },
      { messagesAdded: [{ message: { id: "b", threadId: "t", labelIds: ["SENT"] } }] },
      { messagesAdded: [{ message: { id: "a", threadId: "t", labelIds: ["INBOX"] } }] },
      { messagesAdded: [{ message: { id: "c", threadId: "t", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] } }] },
      {},
    ],
  });
  assert.deepEqual(ids, ["a", "c"]);
});

test("Gmail errors keep the status and mark rate limits as retryable", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota for user x@y" } }), { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    listHistory({ accessToken: "t", baseUrl: "https://g/gmail/v1", fetchImpl }, { startHistoryId: "1" }),
    (e: unknown) => e instanceof GmailApiError && e.status === 429 && e.isTransient && !e.message.includes("x@y"),
  );
});
