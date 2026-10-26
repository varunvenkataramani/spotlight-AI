// Explains a DATABASE_URL in a log-safe way (never prints the password) and points out
// the common copy-paste mistakes, so a failed connection says what to fix.

export function describeDatabaseUrl(raw: string): string {
  const value = raw.trim();
  const problems: string[] = [];
  if (/^["']|["']$/.test(value)) problems.push("the value is wrapped in quotes; remove them");

  let url: URL;
  try {
    url = new URL(value.replace(/^["']|["']$/g, ""));
  } catch {
    return "DATABASE_URL is not a valid address. It should start with postgresql:// and contain no spaces.";
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) problems.push("it should start with postgresql://");

  let password = url.password;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    problems.push("the password contains a % that isn't valid in an address; reset it to a generated one");
  }
  const port = url.port || "5432";

  if (!password) problems.push("there is no password between the : and the @");
  if (password.includes("YOUR-PASSWORD")) problems.push("the [YOUR-PASSWORD] placeholder is still there");
  else if (/^\[.*\]$/.test(password)) problems.push("the password is still inside square brackets; remove the [ and ]");
  if (/\s/.test(password)) problems.push("the password contains a space");
  if (url.hostname.endsWith("pooler.supabase.com") && !url.username.includes(".")) {
    problems.push('for the Supabase pooler the user must look like "postgres.<project-ref>"');
  }

  const summary =
    `user "${url.username}", host "${url.hostname}", port ${port}, ` +
    `database "${url.pathname.replace(/^\//, "") || "(none)"}", password ${password.length} characters`;
  const advice =
    url.hostname.endsWith("pooler.supabase.com") && port === "5432"
      ? " Note: this is the session pooler, which allows only a few connections; on Vercel use the transaction pooler (port 6543)."
      : "";
  return problems.length > 0
    ? `${summary}. Problems found: ${problems.join("; ")}.${advice}`
    : `${summary}. The address is well formed, so the password itself doesn't match the database's current password.${advice}`;
}
