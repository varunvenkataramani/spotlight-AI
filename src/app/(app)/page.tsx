import type { Metadata } from "next";
import Link from "next/link";
import { ErrorPanel, PageHeader, StatusDot, formatIST } from "@/components/ui";
import { getInboxConnection, getOverviewCounts, type InboxConnection, type OverviewCounts } from "@/server/overview.ts";

export const metadata: Metadata = { title: "Overview" };

const TODAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });

export default async function OverviewPage() {
  let counts: OverviewCounts;
  let inbox: InboxConnection;
  try {
    [counts, inbox] = await Promise.all([getOverviewCounts(), getInboxConnection()]);
  } catch {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorPanel title="The database can't be reached">
          Spotlight couldn't load your opportunities. Check that DATABASE_URL is set and the migrations have run (npm run
          migrate), then reload this page. The status of each part is on the <Link className="underline" href="/settings">Settings</Link> page.
        </ErrorPanel>
      </>
    );
  }

  const attention = counts.highPriority + counts.needsReply + counts.dueThisWeek;
  const lead = !inbox
    ? "No inbox is connected yet, so there's nothing to sort. Gmail connection is the next part being built."
    : attention === 0
      ? "Nothing needs you right now."
      : `${attention} ${attention === 1 ? "thing needs" : "things need"} your attention.`;

  const figures: Array<{ label: string; value: number; strong?: boolean }> = [
    { label: "High priority", value: counts.highPriority, strong: true },
    { label: "Need a reply", value: counts.needsReply },
    { label: "Due in 7 days", value: counts.dueThisWeek },
    { label: "New", value: counts.newOpportunities },
    { label: "Drafts to review", value: counts.draftsToReview },
    { label: "Waiting on them", value: counts.awaitingThem },
  ];

  return (
    <>
      <PageHeader title={TODAY.format(new Date())} lead={lead} />

      <section aria-label="Counts" className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {figures.map((f) => (
          <div key={f.label} className="bg-surface px-5 py-5">
            <p
              className={`font-display text-4xl font-semibold tabular-nums ${
                f.strong && f.value > 0 ? "text-ink underline decoration-gel decoration-4 underline-offset-8" : ""
              } ${f.value === 0 ? "text-ink/35" : ""}`}
            >
              {f.value}
            </p>
            <p className="mt-2 text-sm text-muted">{f.label}</p>
          </div>
        ))}
      </section>

      <section className="mt-10 grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-xl font-semibold">Inbox</h2>
          {inbox ? (
            <div className="mt-3 space-y-1 text-sm">
              <p className="flex items-center gap-2">
                <StatusDot tone={inbox.status === "connected" ? "ok" : "bad"} />
                <span className="font-medium">{inbox.email}</span>
              </p>
              <p className="text-muted">Last checked {formatIST(inbox.last_synced_at)}</p>
              {inbox.last_error && <p className="text-alert">{inbox.last_error}</p>}
            </div>
          ) : (
            <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted">
              <span className="mt-1.5"><StatusDot tone="idle" /></span>
              Not connected. Once Gmail is connected, new offers show up here within minutes, even with this page closed.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-xl font-semibold">Needs review</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {counts.needsReview === 0
              ? "No uncertain emails. When the AI isn't sure about an email, it waits here for you instead of being dropped."
              : `${counts.needsReview} ${counts.needsReview === 1 ? "email is" : "emails are"} waiting for a decision.`}
          </p>
          <Link href="/review" className="mt-4 inline-block text-sm font-medium underline decoration-gel decoration-2 underline-offset-4">
            Open the review queue
          </Link>
        </div>
      </section>
    </>
  );
}
