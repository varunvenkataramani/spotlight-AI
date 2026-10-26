// A stand-in for the Telegram Bot API, used only by scripts/test/alerts-e2e.sh.
// Records every call; chat "403403" behaves like a chat that blocked the bot; failures can be queued.
import http from "node:http";

const PORT = Number(process.env.FAKE_TELEGRAM_PORT ?? 4040);
let calls = []; // { method, body }
let failNext = 0;
let messageId = 100;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/_control/calls") return send(res, 200, calls);
      if (url.pathname === "/_control/reset") {
        calls = [];
        failNext = 0;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/_control/fail") {
        failNext = Number(url.searchParams.get("count") ?? 1);
        return send(res, 200, { ok: true });
      }
      const m = /^\/bot(\d+:[A-Za-z0-9_-]+)\/(\w+)$/.exec(url.pathname);
      if (!m || req.method !== "POST") return send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(res, 400, { ok: false, error_code: 400, description: "Bad Request: invalid JSON" });
      }
      const method = m[2];
      calls.push({ method, body });
      if (method === "getMe") return send(res, 200, { ok: true, result: { id: 1, is_bot: true, username: "SpotlightTestBot" } });
      if (method === "setWebhook") return send(res, 200, { ok: true, result: true });
      if (method === "sendMessage") {
        if (String(body.chat_id) === "403403") return send(res, 403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
        if (failNext > 0) {
          failNext--;
          return send(res, 502, { ok: false, error_code: 502, description: "Bad Gateway" });
        }
        return send(res, 200, { ok: true, result: { message_id: ++messageId, chat: { id: body.chat_id }, text: body.text } });
      }
      return send(res, 200, { ok: true, result: true });
    });
  })
  .listen(PORT, () => console.log(`fake telegram on ${PORT}`));
