// A stand-in for a browser push service (like Google's or Apple's), used only by scripts/test/alerts-e2e.sh.
// It hands out subscriptions with real browser-side keys, and for every push it checks the server's
// signed token and decrypts the message exactly as a phone would, recording what it read.
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.FAKE_PUSH_PORT ?? 4041);
const devices = new Map(); // id -> { ecdh, auth }
let received = []; // { id, ok, problem, payload, urgency, ttl }

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function checkToken(header, origin) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return "no vapid header";
  const pub = Buffer.from(m[4], "base64url");
  const key = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  if (!crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"))) return "bad signature";
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
  if (claims.aud !== origin) return `wrong audience ${claims.aud}`;
  if (!(claims.exp > Date.now() / 1000)) return "expired token";
  if (typeof claims.sub !== "string" || !/^(mailto:|https:)/.test(claims.sub)) return "bad subject";
  return null;
}

function decrypt(body, device) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const shared = device.ecdh.computeSecret(asPublic);
  const uaPublic = device.ecdh.getPublicKey();
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, device.auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = body.subarray(21 + idLen);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  if (plain.at(-1) !== 2) throw new Error("bad padding");
  return JSON.parse(plain.subarray(0, -1).toString());
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname === "/_control/new") {
        // A new "phone": returns the subscription a browser would hand to Spotlight.
        const id = url.searchParams.get("id") ?? crypto.randomUUID();
        const ecdh = crypto.createECDH("prime256v1");
        ecdh.generateKeys();
        const auth = crypto.randomBytes(16);
        devices.set(id, { ecdh, auth });
        return send(res, 200, {
          endpoint: `http://localhost:${PORT}/push/${id}`,
          keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
        });
      }
      if (url.pathname === "/_control/received") return send(res, 200, received);
      if (url.pathname === "/_control/reset") {
        received = [];
        return send(res, 200, { ok: true });
      }
      const m = /^\/push\/([\w-]+)$/.exec(url.pathname);
      if (!m || req.method !== "POST") return send(res, 404, {});
      const id = m[1];
      if (id.startsWith("gone")) {
        received.push({ id, ok: false, problem: "gone" });
        return send(res, 410, {});
      }
      const device = devices.get(id);
      if (!device) return send(res, 404, {});
      const problem =
        checkToken(req.headers.authorization, `http://localhost:${PORT}`) ??
        (req.headers["content-encoding"] !== "aes128gcm" ? "wrong content-encoding" : null) ??
        (!req.headers.ttl ? "no TTL" : null);
      let payload = null;
      let decryptProblem = null;
      try {
        payload = decrypt(Buffer.concat(chunks), device);
      } catch (e) {
        decryptProblem = `could not decrypt: ${e.message}`;
      }
      received.push({ id, ok: !problem && !decryptProblem, problem: problem ?? decryptProblem, payload, urgency: req.headers.urgency ?? null, ttl: req.headers.ttl ?? null });
      return send(res, problem || decryptProblem ? 400 : 201, {});
    });
  })
  .listen(PORT, () => console.log(`fake push service on ${PORT}`));
