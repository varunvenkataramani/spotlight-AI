// Reads configuration from environment variables when first needed (never at import time,
// so builds work without secrets) and reports every missing variable at once.
import { parseAllowlist } from "./allowlist.ts";
import { assertSecret } from "./signed-value.ts";
import { parseEncryptionKey } from "./token-crypto.ts";
import { TELEGRAM_TOKEN_PATTERN, webhookSecretFor, type TelegramConfig } from "./alerts/telegram.ts";
import { deriveVapidKeys, type VapidKeys } from "./alerts/webpush.ts";

export type WebConfig = {
  appUrl: string;
  databaseUrl: string;
  admins: Set<string>;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  isProduction: boolean;
  /** The public showcase copy (DEMO_MODE=on): made-up data, no Google, no AI, nothing sent. */
  demo: boolean;
};

export class ConfigError extends Error {}

// --- Demo mode ---------------------------------------------------------------------------------------
// A public showcase copy with made-up offers: no Google sign-in, no Gmail, no AI, nothing sent.
// It must run on its own Vercel project and database, so it refuses to start next to real accounts.

/** The two made-up admins visitors enter the demo as. */
export const DEMO_MANAGER_EMAIL = "kabir.demo@example.com";
export const DEMO_TALENT_EMAIL = "tara.demo@example.com";
const REAL_ACCOUNT_SETTINGS = ["GOOGLE_CLIENT_SECRET", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TOKEN_ENCRYPTION_KEY"];

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_MODE?.trim() === "on";
}

function assertDemoIsolated(env: NodeJS.ProcessEnv) {
  const real = REAL_ACCOUNT_SETTINGS.filter((n) => env[n]?.trim());
  if (real.length > 0) {
    throw new ConfigError(
      `DEMO_MODE is on, but real account settings are present (${real.join(", ")}). Run the demo as its own Vercel project with its own database, without them.`,
    );
  }
}

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

export type AlertConfig = {
  appUrl: string;
  admins: Set<string>;
  /** Null when TELEGRAM_BOT_TOKEN isn't set: Telegram alerts are simply off. */
  telegram: TelegramConfig | null;
  push: { keys: VapidKeys; subject: string; extraOrigins: string[] };
};

/** What alerts need. Telegram is optional; phone notifications need nothing extra. */
export function readAlertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const demo = isDemoMode(env);
  if (demo) assertDemoIsolated(env);
  const v = required(env, demo ? ["APP_URL", "SESSION_SECRET"] : ["APP_URL", "ADMIN_EMAILS", "SESSION_SECRET"]);
  let sessionSecret: string;
  try {
    sessionSecret = assertSecret(v.SESSION_SECRET);
  } catch {
    throw new ConfigError("SESSION_SECRET is too short. Use a generated secret of at least 32 characters.");
  }
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (token && !TELEGRAM_TOKEN_PATTERN.test(token)) {
    throw new ConfigError("TELEGRAM_BOT_TOKEN doesn't look like a bot token from @BotFather (numbers, a colon, then letters).");
  }
  const appUrl = v.APP_URL!.replace(/\/+$/, "");
  return {
    appUrl,
    admins: demo ? new Set([DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL]) : parseAllowlist(v.ADMIN_EMAILS),
    telegram: token
      ? { token, apiBase: env.TELEGRAM_API_BASE?.trim().replace(/\/+$/, "") || "https://api.telegram.org", webhookSecret: webhookSecretFor(token, sessionSecret) }
      : null,
    push: {
      keys: deriveVapidKeys(sessionSecret),
      subject: /^https:\/\//.test(appUrl) ? appUrl : "mailto:alerts@spotlight.invalid",
      // Only for automated tests that run a stand-in push service.
      extraOrigins: (env.PUSH_TEST_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  };
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return required(env, ["DATABASE_URL"]).DATABASE_URL!;
}

export function readWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  if (isDemoMode(env)) {
    assertDemoIsolated(env);
    const d = required(env, ["APP_URL", "DATABASE_URL", "SESSION_SECRET"]);
    if (!/^https?:\/\/[^/\s]+/.test(d.APP_URL!)) throw new ConfigError("APP_URL must start with https:// followed by the site's address.");
    let secret: string;
    try {
      secret = assertSecret(d.SESSION_SECRET);
    } catch {
      throw new ConfigError("SESSION_SECRET is too short. Use a generated secret of at least 32 characters.");
    }
    return {
      appUrl: d.APP_URL!.replace(/\/+$/, ""),
      databaseUrl: d.DATABASE_URL!,
      admins: new Set([DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL]),
      googleClientId: "",
      googleClientSecret: "",
      sessionSecret: secret,
      isProduction: env.NODE_ENV === "production",
      demo: true,
    };
  }
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
    demo: false,
  };
}
