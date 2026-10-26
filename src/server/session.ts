// Admin sessions: a signed, httpOnly cookie, re-checked against ADMIN_EMAILS on every request,
// so removing someone from the allow-list locks them out immediately.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readWebConfig } from "@/lib/config.ts";
import { isAllowedAdmin } from "@/lib/allowlist.ts";
import { createSignedValue, readSignedValue } from "@/lib/signed-value.ts";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type AdminSession = { userId: string; email: string; name: string | null };

export function sessionCookieName(isProduction: boolean): string {
  // __Host- cookies must be Secure, path=/ and host-only: they cannot be set by a subdomain.
  return isProduction ? "__Host-spotlight_session" : "spotlight_session";
}

export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function createSessionToken(session: AdminSession, secret: string): string {
  return createSignedValue(session, SESSION_TTL_SECONDS, secret);
}

export async function getCurrentAdmin(): Promise<AdminSession | null> {
  const config = readWebConfig();
  const store = await cookies();
  const session = readSignedValue<AdminSession>(
    store.get(sessionCookieName(config.isProduction))?.value,
    config.sessionSecret,
  );
  if (!session || !isAllowedAdmin(session.email, config.admins)) return null;
  return session;
}

/** Use at the top of every protected page, layout and route handler. */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getCurrentAdmin();
  if (!session) redirect("/login");
  return session;
}
