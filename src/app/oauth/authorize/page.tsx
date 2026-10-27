import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ConfigError, isDemoMode, readWebConfig } from "@/lib/config.ts";
import { checkAuthorize } from "@/server/oauth.ts";
import { getCurrentAdmin } from "@/server/session.ts";

export const metadata: Metadata = { title: "Connect Claude" };
export const dynamic = "force-dynamic";

const FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (isDemoMode()) notFound(); // No Claude connector in the demo.
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
  };
  let appUrl: string;
  try {
    appUrl = readWebConfig().appUrl;
  } catch (error) {
    if (error instanceof ConfigError) redirect("/login?error=config");
    throw error;
  }
  const check = await checkAuthorize(get, appUrl);
  if (check.kind === "redirect") redirect(check.url);
  if (check.kind === "show_error") {
    return (
      <Frame>
        <h1 className="font-display text-3xl font-semibold">Can't connect</h1>
        <p className="mt-3 leading-relaxed text-muted">{check.message}</p>
      </Frame>
    );
  }

  const admin = await getCurrentAdmin();
  if (!admin) {
    const query = new URLSearchParams(FIELDS.flatMap((k) => (get(k) === null ? [] : [[k, get(k)!]])));
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`);
  }
  const host = new URL(check.params.redirectUri).host;

  return (
    <Frame>
      <p className="text-sm font-medium text-muted">Spotlight</p>
      <h1 className="mt-1 font-display text-3xl font-semibold leading-tight">Connect Claude to Spotlight?</h1>
      <p className="mt-3 leading-relaxed text-muted">{`Signed in as ${admin.email}. Claude will act as you.`}</p>

      <h2 className="mt-6 text-sm font-semibold">Claude will be able to</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
        <li>read your offers, their details and the emails they came from</li>
        <li>add notes, change a status, set reminders and snooze, when you ask</li>
        <li>put an offer to her, or record her answer, when you ask</li>
      </ul>
      <h2 className="mt-4 text-sm font-semibold">Claude won't be able to</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
        <li>send email, or accept, confirm or decline an offer</li>
        <li>see or change settings, Gmail access or the other admin's alerts</li>
      </ul>
      <p className="mt-4 text-xs text-muted">{`After you choose, you'll go back to ${host}. You can disconnect any time in Spotlight's Settings.`}</p>

      <form method="post" action="/api/oauth/authorize" className="mt-6 flex flex-wrap gap-3">
        {FIELDS.map((k) => (get(k) === null ? null : <input key={k} type="hidden" name={k} value={get(k)!} />))}
        <button name="decision" value="allow" className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-paper hover:bg-ink-soft">
          Allow
        </button>
        <button name="decision" value="deny" className="rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-medium hover:border-ink/30">
          Don't allow
        </button>
      </form>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 sm:p-8">{children}</div>
    </main>
  );
}
