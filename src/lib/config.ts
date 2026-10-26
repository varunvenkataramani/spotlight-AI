// Reads configuration from environment variables when first needed (never at import time,
// so builds work without secrets) and reports every missing variable at once.
import { parseAllowlist } from "./allowlist.ts";
import { assertSecret } from "./signed-value.ts";

export type WebConfig = {
  appUrl: string;
  databaseUrl: string;
  admins: Set<string>;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  isProduction: boolean;
};

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Missing environment variables: ${missing.join(", ")}. See .env.example.`);
  }
  return Object.fromEntries(names.map((n) => [n, env[n]!.trim()]));
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return required(env, ["DATABASE_URL"]).DATABASE_URL!;
}

export function readWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const v = required(env, [
    "APP_URL",
    "DATABASE_URL",
    "ADMIN_EMAILS",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "SESSION_SECRET",
  ]);
  const admins = parseAllowlist(v.ADMIN_EMAILS);
  if (admins.size === 0) throw new ConfigError("ADMIN_EMAILS has no valid email addresses.");
  return {
    appUrl: v.APP_URL!.replace(/\/+$/, ""),
    databaseUrl: v.DATABASE_URL!,
    admins,
    googleClientId: v.GOOGLE_CLIENT_ID!,
    googleClientSecret: v.GOOGLE_CLIENT_SECRET!,
    sessionSecret: assertSecret(v.SESSION_SECRET),
    isProduction: env.NODE_ENV === "production",
  };
}
