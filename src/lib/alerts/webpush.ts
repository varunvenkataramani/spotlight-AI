// Phone and browser notifications (Web Push), with only Node's built-in crypto:
// message encryption (RFC 8291, "aes128gcm") and the server's signed identity (VAPID, RFC 8292).
//
// The server key pair is derived from SESSION_SECRET, so there is nothing extra to set up.
// If that secret changes, phones simply need notifications turned on again.
import crypto from "node:crypto";

export type VapidKeys = { publicKey: string; privateKey: crypto.KeyObject };
export type PushSubscriptionKeys = { p256dh: string; auth: string };

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

/** The same secret always gives the same key pair. */
export function deriveVapidKeys(secret: string): VapidKeys {
  for (let counter = 0; counter < 16; counter++) {
    const d = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.from("spotlight"), Buffer.from(`web-push server key v1 ${counter}`), 32));
    const ecdh = crypto.createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(d); // rejects the vanishingly rare out-of-range value; try the next one
    } catch {
      continue;
    }
    const pub = ecdh.getPublicKey();
    const privateKey = crypto.createPrivateKey({
      key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
      format: "jwk",
    });
    return { publicKey: b64u(pub), privateKey };
  }
  throw new Error("Could not derive a push key");
}

/** The Authorization header a push service needs: a short-lived token signed with the server key. */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypts a message so only the subscribed browser can read it (RFC 8291 with RFC 8188 framing,
 * one record). `fixed` is for tests with published example values.
 */
export function encryptPayload(
  plaintext: Buffer | string,
  sub: PushSubscriptionKeys,
  fixed?: { salt: Buffer; serverPrivateKey: Buffer },
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, "base64url");
  const authSecret = Buffer.from(sub.auth, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("bad subscription key");
  if (authSecret.length < 16) throw new Error("bad subscription secret");

  const ecdh = crypto.createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), // 0x02: last (only) record
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

/** The push services browsers use. Anything else is refused, so the server only ever calls these. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

export function isAllowedPushEndpoint(endpoint: string, extraOrigins: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (extraOrigins.includes(url.origin)) return true;
  return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && PUSH_HOSTS.some((h) => h.test(url.hostname));
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number };

/** Sends one notification. `gone` means the subscription should be deleted (expired, or from an older server key). */
export async function sendPush(
  endpoint: string,
  keys: PushSubscriptionKeys,
  payload: object,
  vapid: VapidKeys,
  subject: string,
  options: { urgent: boolean; ttlSeconds?: number; timeoutMs?: number },
): Promise<PushResult> {
  const body = encryptPayload(JSON.stringify(payload), keys);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttlSeconds ?? 24 * 3600),
      Urgency: options.urgent ? "high" : "normal",
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
  });
  await res.arrayBuffer().catch(() => {});
  if (res.ok) return { ok: true };
  return { ok: false, gone: res.status === 404 || res.status === 410 || res.status === 401 || res.status === 403, status: res.status };
}
