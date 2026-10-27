import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConfigError } from "@/lib/config.ts";
import { safeNextPath } from "@/lib/oauth/oauth.ts";
import { getCurrentAdmin } from "@/server/session.ts";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  not_allowed: "That Google account isn't one of the two admin accounts. Sign in with an admin account.",
  access_denied: "Sign-in was cancelled on the Google screen. Try again when you're ready.",
  state_mismatch: "The sign-in link expired or was opened in a different browser. Start again from this page.",
  email_not_verified: "Google hasn't verified the email on that account yet. Verify it with Google, then try again.",
  token_exchange_failed: "Google didn't complete the sign-in. Try again; if it repeats, check the OAuth client settings.",
  invalid_id_token: "Google's response couldn't be verified. Try again; if it repeats, check GOOGLE_CLIENT_ID.",
  config: "Sign-in isn't set up yet: some settings are missing. Add them in Vercel under Environment Variables, then redeploy.",
  unknown: "Sign-in failed for an unexpected reason. Try again in a minute.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; signed_out?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  let alreadySignedIn = false;
  let configProblem: string | null = null;
  try {
    alreadySignedIn = (await getCurrentAdmin()) !== null;
  } catch (e) {
    if (e instanceof ConfigError) configProblem = e.message;
  }
  if (alreadySignedIn) redirect(next ?? "/");

  const error = configProblem
    ? `Sign-in isn't set up yet. ${configProblem}`
    : params.error
      ? (MESSAGES[params.error] ?? MESSAGES.unknown)
      : null;

  return (
    <main className="stage-light flex min-h-dvh items-end text-ink sm:items-center">
      <div className="w-full max-w-xl px-6 pb-16 pt-24 sm:px-16 sm:pb-24">
        <h1 className="font-display text-6xl font-semibold leading-none tracking-tight sm:text-8xl">Spotlight</h1>
        <p className="mt-6 max-w-md text-lg leading-relaxed text-ink/75">
          Every offer in her inbox, read, sorted and ready for a decision.
        </p>

        {error && (
          <p role="alert" className="mt-8 max-w-md rounded-lg border border-alert/50 bg-alert/15 px-4 py-3 text-sm leading-relaxed">
            {error}
          </p>
        )}
        {!error && params.signed_out && (
          <p role="status" className="mt-8 text-sm text-ink/70">
            You're signed out.
          </p>
        )}

        <a
          href={next ? `/api/auth/login?next=${encodeURIComponent(next)}` : "/api/auth/login"}
          className="mt-10 inline-flex items-center gap-3 rounded-full bg-gel px-6 py-3 font-semibold text-stage transition-colors hover:bg-[#f6c460]"
        >
          <GoogleMark />
          Continue with Google
        </a>
        <p className="mt-4 text-sm text-ink/55">
          {next?.startsWith("/oauth/authorize") ? "Sign in to connect Claude to Spotlight. Only the two admin accounts can." : "Only the two admin accounts can sign in."}
        </p>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.8-3.8H1.3v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8Z" />
    </svg>
  );
}
