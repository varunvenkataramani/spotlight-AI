import { timingSafeEqual } from "node:crypto";

/** Compares an "Authorization: Bearer ..." header with a shared secret in constant time. */
export function isAuthorizedBearer(authorizationHeader: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !authorizationHeader) return false;
  const given = Buffer.from(authorizationHeader);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
