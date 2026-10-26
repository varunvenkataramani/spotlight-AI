import type { Metadata } from "next";
import { PageHeader, StatusDot, formatIST } from "@/components/ui";
import { readWebConfig } from "@/lib/config.ts";
import { getSystemHealth } from "@/server/health.ts";
import { getInboxConnection } from "@/server/overview.ts";
import { listAdmins, type AdminRow } from "@/server/users.ts";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const config = readWebConfig();
  const health = await getSystemHealth();
  let admins: AdminRow[] = [];
  let inbox = null;
  if (health.database === "ok") {
    [admins, inbox] = await Promise.all([listAdmins(), getInboxConnection()]);
  }
  const lastLogin = new Map(admins.map((a) => [a.email, a.last_login_at]));

  const workerText = {
    ok: `Running. Last check-in ${formatIST(health.workerLastBeatAt)}.`,
    stale: `Not responding since ${formatIST(health.workerLastBeatAt)}. Restart the worker service.`,
    never_seen: "Never started. Deploy and start the worker service (npm run worker).",
    unknown: "Unknown until the database is reachable.",
  }[health.worker];

  return (
    <>
      <PageHeader title="Settings" />

      <section className="rounded-2xl border border-line bg-surface p-6">
        <h2 className="font-display text-xl font-semibold">System status</h2>
        <dl className="mt-4 divide-y divide-line text-sm">
          <div className="flex items-start gap-3 py-3">
            <StatusDot tone={health.database === "ok" ? "ok" : "bad"} />
            <dt className="w-24 shrink-0 font-medium">Database</dt>
            <dd className="text-muted">
              {health.database === "ok" ? "Connected." : `Can't connect: ${health.databaseError}`}
            </dd>
          </div>
          <div className="flex items-start gap-3 py-3">
            <StatusDot tone={health.worker === "ok" ? "ok" : health.worker === "stale" ? "bad" : "warn"} />
            <dt className="w-24 shrink-0 font-medium">Worker</dt>
            <dd className="text-muted">{workerText}</dd>
          </div>
          <div className="flex items-start gap-3 py-3">
            <StatusDot tone={inbox ? (inbox.status === "connected" ? "ok" : "bad") : "idle"} />
            <dt className="w-24 shrink-0 font-medium">Gmail</dt>
            <dd className="text-muted">{inbox ? `${inbox.email}, ${inbox.status.replace("_", " ")}.` : "Not connected yet."}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-2xl border border-line bg-surface p-6">
        <h2 className="font-display text-xl font-semibold">Admins</h2>
        <p className="mt-1 text-sm text-muted">Both have full access. To change who can sign in, edit ADMIN_EMAILS in the hosting settings.</p>
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

      <form action="/api/auth/logout" method="post" className="mt-8">
        <button type="submit" className="rounded-full border border-line bg-surface px-5 py-2 text-sm font-medium hover:border-ink/30">
          Sign out
        </button>
      </form>
    </>
  );
}
