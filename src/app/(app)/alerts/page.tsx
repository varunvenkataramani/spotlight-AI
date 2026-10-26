import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { listAlerts, markAlertsRead } from "@/server/alerts.ts";
import { requireAdmin } from "@/server/session.ts";

export const metadata: Metadata = { title: "Alerts" };

const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default async function AlertsPage() {
  const admin = await requireAdmin();
  const items = await listAlerts(admin);
  // Opening this page counts as reading them.
  if (items.some((i) => !i.read_at)) await markAlertsRead(admin);

  return (
    <>
      <PageHeader
        title="Alerts"
        lead={
          <>
            What Spotlight told you about, newest first. Choose what reaches your phone in{" "}
            <Link href="/settings#alerts" className="underline decoration-gel decoration-2 underline-offset-4">
              Settings
            </Link>
            .
          </>
        }
      />
      {items.length === 0 ? (
        <EmptyState title="No alerts yet">
          Strong new offers, replies due within a day, changed terms, offers waiting on you, and anything flagged for her will be listed here as they
          happen, and sent to Telegram or your phone if you turn that on.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {items.map((a) => (
            <li key={a.id}>
              <Link href={a.url ?? "/"} className="grid gap-1 px-5 py-4 hover:bg-paper sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    {!a.read_at && <span className="rounded-full bg-gel px-2 py-0.5 text-xs font-semibold">New</span>}
                    <span className="font-medium">{a.title}</span>
                  </span>
                  {a.body && <span className="mt-0.5 block whitespace-pre-line break-words text-sm text-muted">{a.body}</span>}
                </span>
                <span className="text-sm tabular-nums text-muted sm:text-right">{WHEN.format(a.created_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
