// Reads configuration from environment variables when first needed (never at import time,
// so builds work without secrets) and reports every missing variable at once.
import { parseAllowlist } from "./allowlist.ts";
import { assertSecret } from "./signed-value.ts";
import { parseEncryptionKey } from "./token-crypto.ts";

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
    throw new ConfigError(
      `Missing settings: ${missing.join(", ")}. Add them in Vercel under Environment Variables (Production), then redeploy.`,
    );
  }
  return Object.fromEntries(names.map((n) => [n, env[n]!.trim()]));
}

export type GmailConfig = { clientId: string; clientSecret: string; tokenKey: Buffer };

/** What background Gmail sync needs: the OAuth client and the token encryption key. */
export function readGmailConfig(env: NodeJS.ProcessEnv = process.env): GmailConfig {
  const v = required(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
  let tokenKey: Buffer;
  try {
    tokenKey = parseEncryptionKey(v.TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new ConfigError("TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64 (a generated secret).");
  }
  return { clientId: v.GOOGLE_CLIENT_ID!, clientSecret: v.GOOGLE_CLIENT_SECRET!, tokenKey };
}

export type AiConfig = { apiKey: string; triageModel: string; extractModel: string };

export const DEFAULT_TRIAGE_MODEL = "claude-haiku-5-5";
export const DEFAULT_EXTRACT_MODEL = "claude-sonnet-5-5";

/** What AI sorting needs. Without ANTHROPIC_API_KEY, sorting is simply off. */
export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const v = required(env, ["ANTHROPIC_API_KEY"]);
  return {
    apiKey: v.ANTHROPIC_API_KEY!,
    triageModel: env.ANTHROPIC_TRIAGE_MODEL?.trim() || DEFAULT_TRIAGE_MODEL,
    extractModel: env.ANTHROPIC_EXTRACT_MODEL?.trim() || DEFAULT_EXTRACT_MODEL,
  };
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
  if (!/^https?:\/\/[^/\s]+/.test(v.APP_URL!)) {
    throw new ConfigError("APP_URL must start with https:// followed by the site's address.");
  }
  let sessionSecret: string;
  try {
    sessionSecret = assertSecret(v.SESSION_SECRET);
  } catch {
    throw new ConfigError("SESSION_SECRET is too short. Use a generated secret of at least 32 characters.");
  }
  return {
    appUrl: v.APP_URL!.replace(/\/+$/, ""),
    databaseUrl: v.DATABASE_URL!,
    admins,
    googleClientId: v.GOOGLE_CLIENT_ID!,
    googleClientSecret: v.GOOGLE_CLIENT_SECRET!,
    sessionSecret,
    isProduction: env.NODE_ENV === "production",
  };
}
