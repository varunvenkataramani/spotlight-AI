// Only the admins named in ADMIN_EMAILS can sign in.

export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0 && e.includes("@")),
  );
}

export function isAllowedAdmin(email: string | undefined | null, allowlist: Set<string>): boolean {
  if (!email) return false;
  return allowlist.has(email.trim().toLowerCase());
}
