// A stand-in for Gmail's drafts and send endpoints (and Google's consent page), used only by
// scripts/test/drafts-e2e.sh. Records every message it's given, decoded, so the test can check it.
import http from "node:http";

const PORT = Number(process.env.FAKE_GMAIL_WRITE_PORT ?? 4061);
let calls = []; // { kind: "draft" | "send", threadId, raw (decoded MIME), auth }
let failNext = null; // HTTP status to answer the next write with
let n = 0;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname === "/_control/calls") return send(res, 200, calls);
      if (url.pathname === "/_control/fail") {
        failNext = Number(url.searchParams.get("status") ?? 500);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/auth") return send(res, 200, { consent: "page" });
      if (url.pathname === "/token") return send(res, 200, { access_token: "fresh-access", expires_in: 3599 });
      const m = /^\/gmail\/v1\/users\/me\/(drafts|messages\/send)$/.exec(url.pathname);
      if (!m || req.method !== "POST") return send(res, 404, { error: { status: "NOT_FOUND" } });
      if (failNext) {
        const status = failNext;
        failNext = null;
        return send(res, status, { error: { status: status === 403 ? "PERMISSION_DENIED" : "INTERNAL" } });
      }
      const body = JSON.parse(raw || "{}");
      const encoded = m[1] === "drafts" ? body.message?.raw : body.raw;
      const threadId = m[1] === "drafts" ? body.message?.threadId : body.threadId;
      calls.push({
        kind: m[1] === "drafts" ? "draft" : "send",
        threadId: threadId ?? null,
        raw: Buffer.from(encoded ?? "", "base64url").toString("utf8"),
        auth: req.headers.authorization ?? null,
      });
      n++;
      return m[1] === "drafts" ? send(res, 200, { id: `r-draft-${n}`, message: { id: `m-${n}` } }) : send(res, 200, { id: `sent-${n}`, threadId });
    });
  })
  .listen(PORT, () => console.log(`fake gmail writer on ${PORT}`));
