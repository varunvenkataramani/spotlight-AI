import type { Metadata } from "next";
import { InboxPanel } from "@/components/InboxPanel";
import { PageHeader, StatusDot, formatIST } from "@/components/ui";
import { readWebConfig } from "@/lib/config.ts";
import { getInboxStatus, type InboxStatus } from "@/server/gmail.ts";
import { getSystemHealth } from "@/server/health.ts";
import { listAdmins, type AdminRow } from "@/server/users.ts";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ gmail?: string }> }) {
  const { gmail: outcome } = await searchParams;
  const config = readWebConfig();
  const health = await getSystemHealth();
  let admins: AdminRow[] = [];
  let inbox: InboxStatus | null = null;
  if (health.database === "ok") {
    [admins, inbox] = await Promise.all([listAdmins(), getInboxStatus()]);
  }
  const lastLogin = new Map(admins.map((a) => [a.email, a.last_login_at]));

  const schedulerText = {
    ok: `Running every minute. Last run ${formatIST(health.schedulerLastRunAt)}.`,
    stale: `No run since ${formatIST(health.schedulerLastRunAt)}. Check the spotlight-tick job in Supabase (Integrations > Cron).`,
    never_seen: "Hasn't run yet. Set up the spotlight-tick job in Supabase (README, step 4).",
    unknown: "Unknown until the database is reachable.",
  }[health.scheduler];

  return (
    <>
      <PageHeader title="Settings" />

      <div className="space-y-6">
        {health.database === "ok" && <InboxPanel inbox={inbox} outcome={outcome} />}

        <section className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-xl font-semibold">System status</h2>
          <dl className="mt-4 divide-y divide-line text-sm">
            <div className="flex items-start gap-3 py-3">
              <StatusDot tone={health.database === "ok" ? "ok" : "bad"} />
              <dt className="w-32 shrink-0 font-medium">Database</dt>
              <dd className="text-muted">
                {health.database === "ok" ? "Connected." : `Can't connect: ${health.databaseError}`}
              </dd>
            </div>
            <div className="flex items-start gap-3 py-3">
              <StatusDot tone={health.scheduler === "ok" ? "ok" : health.scheduler === "stale" ? "bad" : "warn"} />
              <dt className="w-32 shrink-0 font-medium">Background jobs</dt>
              <dd className="text-muted">{schedulerText}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-xl font-semibold">Admins</h2>
          <p className="mt-1 text-sm text-muted">
            Both have full access. To change who can sign in, edit ADMIN_EMAILS in Vercel and redeploy.
          </p>
          <ul className="mt-4 divide-y divide-line text-sm">
            {[...config.admins].map((email) => (
              <li key={email} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <span className="font-medium">{email}</span>
                <span className="text-muted">
                  {lastLogin.get(email) ? `Last signed in ${formatIST(lastLogin.get(email))}` : "Hasn't signed in yet"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <form action="/api/auth/logout" method="post" className="mt-8">
        <button type="submit" className="rounded-full border border-line bg-surface px-5 py-2 text-sm font-medium hover:border-ink/30">
          Sign out
        </button>
      </form>
    </>
  );
}
