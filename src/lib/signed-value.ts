// Tamper-proof, expiring values for cookies (session, OAuth state).
// Format: <base64url JSON payload>.<base64url HMAC-SHA256>. Not encrypted: never put secrets inside.
import { createHmac, timingSafeEqual } from "node:crypto";

type Envelope<T> = { v: T; exp: number };

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function assertSecret(secret: string | undefined, name = "SESSION_SECRET"): string {
  if (!secret || secret.length < 32) {
    throw new Error(`${name} must be set to at least 32 characters (npm run gen:secret)`);
  }
  return secret;
}

export function createSignedValue<T>(value: T, ttlSeconds: number, secret: string, now = Date.now()): string {
  const envelope: Envelope<T> = { v: value, exp: Math.floor(now / 1000) + ttlSeconds };
  const data = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

/** Returns the value, or null if the signature is wrong, the value is malformed or it has expired. */
export function readSignedValue<T>(token: string | undefined | null, secret: string, now = Date.now()): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(data, secret), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const envelope = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Envelope<T>;
    if (typeof envelope.exp !== "number" || envelope.exp * 1000 <= now) return null;
    return envelope.v;
  } catch {
    return null;
  }
}
