// A small stand-in for Google's OAuth and Gmail APIs, used only by scripts/test/gmail-e2e.sh.
// It holds one mailbox in memory and has /_control endpoints the test uses to change it.
import http from "node:http";

const PORT = Number(process.env.FAKE_GOOGLE_PORT ?? 4010);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const INBOX = "test.inbox@gmail.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";

const state = {
  historyId: 1000,
  minValidHistoryId: 0, // history requests below this answer 404, as Gmail does after about a week
  events: [], // { historyId, id, labelIds }
  extra: new Map(), // id -> message for mail added during the test
  accessToken: "access-1",
  tokenEmail: INBOX, // whose mailbox the current access token opens
  revoked: false,
  revokeCalls: 0,
  tokenRefreshes: 0,
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const HOUR = 3600_000;

// The mailbox before connecting: 150 plain emails, one HTML-only email, one that always fails.
const scanIds = [...Array.from({ length: 150 }, (_, i) => `old-${i}`), "old-html", "old-broken"];

function message(id) {
  if (state.extra.has(id)) return state.extra.get(id);
  if (id === "old-html") {
    return {
      id,
      threadId: "t-html",
      labelIds: ["INBOX"],
      snippet: "Launch event invitation",
      internalDate: String(Date.now() - 2 * HOUR),
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "Events Team <events@brand.in>" },
          { name: "Subject", value: "=?UTF-8?B?TGF1bmNoIGV2ZW50IOKAkyAxMiBOb3Y=?=" },
        ],
        body: { data: b64("<h1>Launch event</h1><p>Fee: &#8377;1,50,000</p><script>x()</script>") },
      },
    };
  }
  const m = id.match(/^old-(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    return {
      id,
      threadId: `t-${n}`,
      labelIds: ["INBOX"],
      snippet: `Old mail ${n}`,
      internalDate: String(Date.now() - (n + 3) * HOUR),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: `Sender ${n} <sender${n}@example.com>` },
          { name: "Subject", value: `Old mail ${n}` },
        ],
        body: { data: b64(`Body of old mail ${n}\u0000 with a stray NUL`) },
      },
    };
  }
  return null;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function idToken(email) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: email === INBOX ? "sub-test" : "sub-other",
    email,
    email_verified: true,
  })}.fake-signature`;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // --- OAuth -------------------------------------------------------------------
  if (path === "/auth") {
    // Consent "granted": straight back to the app with a code.
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "good-code");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (path === "/token" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    if (form.get("grant_type") === "authorization_code") {
      if (!form.get("code_verifier")) return send(res, 400, { error: "invalid_request" });
      state.revoked = false;
      state.accessToken = `access-${Date.now()}`;
      const email = form.get("code") === "other-code" ? "someone.else@gmail.com" : INBOX;
      state.tokenEmail = email;
      return send(res, 200, {
        access_token: state.accessToken,
        refresh_token: "fake-refresh-token",
        expires_in: 3599,
        scope: `openid ${READONLY} https://www.googleapis.com/auth/userinfo.email`,
        id_token: idToken(email),
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (state.revoked || form.get("refresh_token") !== "fake-refresh-token") return send(res, 400, { error: "invalid_grant" });
      state.tokenRefreshes++;
      state.tokenEmail = INBOX;
      state.accessToken = `access-${Date.now()}`;
      return send(res, 200, { access_token: state.accessToken, expires_in: 3599 });
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }
  if (path === "/revoke" && req.method === "POST") {
    state.revokeCalls++;
    state.revoked = true;
    return send(res, 200, {});
  }

  // --- Test controls --------------------------------------------------------------
  if (path === "/_control/new-mail" && req.method === "POST") {
    const { id, labelIds = ["INBOX"], subject = `New mail ${id}` } = JSON.parse((await readBody(req)) || "{}");
    state.historyId += 7;
    state.events.push({ historyId: state.historyId, id, labelIds });
    state.extra.set(id, {
      id,
      threadId: `t-${id}`,
      labelIds,
      snippet: subject,
      internalDate: String(Date.now()),
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: '"Priya Shah, Glow Labs" <priya@glowlabs.in>' },
          { name: "Subject", value: subject },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64(`Budget ₹75,000 for one reel. (${id})`) } },
          { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
        ],
      },
    });
    return send(res, 200, { historyId: state.historyId });
  }
  if (path === "/_control/expire-history" && req.method === "POST") {
    state.minValidHistoryId = state.historyId + 1;
    return send(res, 200, {});
  }
  if (path === "/_control/revoke" && req.method === "POST") {
    state.revoked = true;
    state.accessToken = "revoked";
    return send(res, 200, {});
  }
  if (path === "/_control/stats") {
    return send(res, 200, { revokeCalls: state.revokeCalls, tokenRefreshes: state.tokenRefreshes, historyId: state.historyId });
  }

  // --- Gmail API ------------------------------------------------------------------
  if (path.startsWith("/gmail/v1/users/me/")) {
    if (req.headers.authorization !== `Bearer ${state.accessToken}`) {
      return send(res, 401, { error: { status: "UNAUTHENTICATED" } });
    }
    const rest = path.slice("/gmail/v1/users/me/".length);

    if (rest === "profile") return send(res, 200, { emailAddress: state.tokenEmail, historyId: String(state.historyId) });

    if (rest === "messages") {
      const q = url.searchParams.get("q") ?? "";
      const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      if (!q.includes("in:inbox")) return send(res, 400, { error: { status: "INVALID_ARGUMENT" } });
      const all = [...scanIds, ...[...state.extra.keys()]].filter((id) => {
        const m = message(id);
        return m && m.labelIds.includes("INBOX") && Number(m.internalDate) > after;
      });
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = all.slice(start, start + size);
      return send(res, 200, {
        messages: page.map((id) => ({ id, threadId: message(id).threadId })),
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
      });
    }

    if (rest === "history") {
      const startId = Number(url.searchParams.get("startHistoryId"));
      if (startId < state.minValidHistoryId) return send(res, 404, { error: { status: "NOT_FOUND" } });
      const events = state.events.filter((e) => e.historyId > startId);
      return send(res, 200, {
        history: events.map((e) => ({ messagesAdded: [{ message: { id: e.id, threadId: `t-${e.id}`, labelIds: e.labelIds } }] })),
        historyId: String(state.historyId),
      });
    }

    const msg = rest.match(/^messages\/([^/]+)$/);
    if (msg) {
      const id = decodeURIComponent(msg[1]);
      if (id === "old-broken") return send(res, 500, { error: { status: "INTERNAL" } });
      const m = message(id);
      return m ? send(res, 200, m) : send(res, 404, { error: { status: "NOT_FOUND" } });
    }
  }

  send(res, 404, { error: { status: "NOT_FOUND", path } });
});

server.listen(PORT, () => console.log(`fake google listening on ${PORT}`));
