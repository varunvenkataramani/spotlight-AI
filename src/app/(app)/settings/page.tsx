import type { Metadata } from "next";
import { AiPanel } from "@/components/AiPanel";
import { AlertsPanel } from "@/components/AlertsPanel";
import { Flash } from "@/components/detail";
import { InboxPanel } from "@/components/InboxPanel";
import { PageHeader, StatusDot, formatIST } from "@/components/ui";
import { readWebConfig } from "@/lib/config.ts";
import { getInboxStatus, type InboxStatus } from "@/server/gmail.ts";
import { getSystemHealth } from "@/server/health.ts";
import { getAiOverview, type AiOverview } from "@/server/opportunities.ts";
import { getAlertSettings, type AlertSettings } from "@/server/alerts.ts";
import { requireAdmin } from "@/server/session.ts";
import { listAdmins, type AdminRow } from "@/server/users.ts";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string; done?: string; error?: string }>;
}) {
  const { gmail: outcome, done, error } = await searchParams;
  const me = await requireAdmin();
  const config = readWebConfig();
  const health = await getSystemHealth();
  let admins: AdminRow[] = [];
  let inbox: InboxStatus | null = null;
  let ai: AiOverview | null = null;
  let alerts: AlertSettings | null = null;
  if (health.database === "ok") {
    [admins, inbox, ai, alerts] = await Promise.all([listAdmins(), getInboxStatus(), getAiOverview(), getAlertSettings(me)]);
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
      <Flash done={done} error={error} />

      <div className="space-y-6">
        {health.database === "ok" && <InboxPanel inbox={inbox} outcome={outcome} />}
        {alerts && <AlertsPanel s={alerts} isTalent={alerts.talentEmail === me.email} />}
        {ai && <AiPanel ai={ai} />}

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
          {alerts && (
            <form method="post" action="/api/settings" className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
              <input type="hidden" name="action" value="talent" />
              <label htmlFor="talent" className="font-medium">
                Which admin is the actress?
              </label>
              <select id="talent" name="email" defaultValue={alerts.talentEmail ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2">
                <option value="">Not chosen yet</option>
                {[...config.admins].map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
              <button className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft">Save</button>
              <p className="w-full text-xs text-muted">“Flag for her” sends offers to this account, with buttons to answer.</p>
            </form>
          )}
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
