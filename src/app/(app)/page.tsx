import type { Metadata } from "next";
import Link from "next/link";
import { Flash } from "@/components/detail";
import { ErrorPanel, PageHeader, StatusDot, formatIST } from "@/components/ui";
import { getInboxStatus, type InboxStatus } from "@/server/gmail.ts";
import { getOverviewCounts, listFlagged, type FlaggedItem, type OverviewCounts } from "@/server/overview.ts";
import { requireAdmin } from "@/server/session.ts";
import { listOpportunities, listRecentChanges, type OpportunityCard, type RecentChange } from "@/server/opportunities.ts";
import { formatDay, payText, relativeDay } from "@/lib/format.ts";

export const metadata: Metadata = { title: "Overview" };

const TODAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const { done, error: actionError } = await searchParams;
  const me = await requireAdmin();
  let counts: OverviewCounts;
  let inbox: InboxStatus | null;
  let now: OpportunityCard[];
  let changes: RecentChange[];
  let flagged: { items: FlaggedItem[]; talentEmail: string | null };
  try {
    [counts, inbox, now, changes, flagged] = await Promise.all([
      getOverviewCounts(),
      getInboxStatus(),
      listOpportunities({ attention: true, limit: 6 }),
      listRecentChanges(6),
      listFlagged(),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    const busy = /EMAXCONN|max clients|too many clients|timeout exceeded when trying to connect/i.test(reason);
    console.error("Overview failed:", reason);
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorPanel title={busy ? "The database is too busy right now" : "The database couldn't load your opportunities"}>
          {busy
            ? "Every database connection is in use. This usually clears within a minute: reload the page. If it keeps happening, check that DATABASE_URL uses Supabase's transaction pooler (port 6543)."
            : "Reload the page in a minute. If it keeps happening, the details below and the Settings page show what's wrong."}
          <span className="mt-2 block text-xs text-muted">Database said: {reason}</span>
          <Link className="mt-2 inline-block underline" href="/settings">
            Open Settings
          </Link>
        </ErrorPanel>
      </>
    );
  }

  const attention = counts.highPriority + counts.needsReply + counts.dueThisWeek;
  const lead = !inbox
    ? "No inbox is connected yet. Connect Gmail in Settings to start."
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

  const isHer = flagged.talentEmail === me.email;
  const waitingForHer = flagged.items.filter((f) => !f.talent_response);

  return (
    <>
      <PageHeader title={TODAY.format(new Date())} lead={isHer && waitingForHer.length > 0 ? `${waitingForHer.length} ${waitingForHer.length === 1 ? "offer is" : "offers are"} waiting for your answer.` : lead} />
      <Flash done={done} error={actionError} />

      {flagged.items.length > 0 && <HerCalls items={flagged.items} isHer={isHer} />}

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

      <section className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold">Needs you now</h2>
          {now.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              Nothing urgent. High-priority offers, anything due within a week, and unread cards show up here.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {now.map((o) => (
                <li key={o.id}>
                  <Link href={`/opportunities/${o.id}`} className="grid gap-1 px-5 py-4 hover:bg-paper sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        {o.priority === "high" && <span className="rounded-full bg-gel px-2 py-0.5 text-xs font-semibold">High</span>}
                        {o.priority === "needs_review" && <span className="rounded-full border border-alert/60 px-2 py-0.5 text-xs text-alert">Check</span>}
                        {!o.is_read && <span className="rounded-full bg-ink px-2 py-0.5 text-xs font-semibold text-paper">Unread</span>}
                        <span className="truncate font-medium">{o.title}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-muted">
                        {[o.organization ?? o.sender_name, payText(o)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums text-muted sm:text-right">
                      {o.next_deadline_at ? `Due ${relativeDay(o.next_deadline_at)}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold">Recent changes</h2>
          {changes.length === 0 ? (
            <p className="mt-3 text-sm text-muted">When a brand changes a fee or date, cancels, or replies, it's listed here.</p>
          ) : (
            <ul className="mt-3 space-y-3 text-sm">
              {changes.map((c, i) => (
                <li key={i} className="leading-relaxed">
                  <Link href={`/opportunities/${c.opportunity_id}`} className="font-medium underline-offset-4 hover:underline">
                    {c.title}
                  </Link>
                  <span className="block text-muted">
                    {describeChange(c)} · {formatDay(c.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-10 grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-xl font-semibold">Inbox</h2>
          {inbox ? (
            <div className="mt-3 space-y-1 text-sm">
              <p className="flex items-center gap-2">
                <StatusDot tone={inbox.status === "connected" ? (inbox.consecutiveFailures >= 3 ? "warn" : "ok") : "bad"} />
                <span className="min-w-0 break-words font-medium">{inbox.email}</span>
              </p>
              <p className="text-muted">
                {inbox.status === "connected" ? `Last checked ${formatIST(inbox.lastSyncedAt)}.` : "Needs reconnecting."}{" "}
                {inbox.storedTotal} emails read, {inbox.storedNew} new since connecting.
              </p>
              <Link href={inbox.status === "connected" ? "/mail" : "/settings#gmail"} className="inline-block pt-2 font-medium underline decoration-gel decoration-2 underline-offset-4">
                {inbox.status === "connected" ? "See synced mail" : "Reconnect in Settings"}
              </Link>
            </div>
          ) : (
            <div className="mt-3 text-sm leading-relaxed text-muted">
              <p className="flex items-start gap-2">
                <span className="mt-1.5"><StatusDot tone="idle" /></span>
                Not connected. Once Gmail is connected, new mail is read within a minute, even with this page closed.
              </p>
              <Link href="/settings#gmail" className="mt-3 inline-block font-medium text-ink underline decoration-gel decoration-2 underline-offset-4">
                Connect Gmail
              </Link>
            </div>
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

const ANSWER = { interested: "Interested", pass: "Pass", questions: "Has questions" } as const;

/** For her: offers waiting for her answer, with the buttons right here. For the team: what she said. */
function HerCalls({ items, isHer }: { items: FlaggedItem[]; isHer: boolean }) {
  return (
    <section className="mb-10 rounded-2xl border border-gel/60 bg-gel-soft/40 p-5">
      <h2 className="font-display text-xl font-semibold">{isHer ? "Your call" : "Her call"}</h2>
      <ul className="mt-3 divide-y divide-line">
        {items.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="min-w-0">
              <Link href={`/opportunities/${f.id}`} className="font-medium underline-offset-4 hover:underline">
                {f.title}
              </Link>
              <span className="block text-sm text-muted">
                {[f.organization, f.talent_response ? `${isHer ? "You said" : "She said"}: ${ANSWER[f.talent_response]}` : isHer ? "Waiting for your answer" : "Waiting for her answer"]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {f.talent_response_note && <span className="block break-words text-sm">“{f.talent_response_note}”</span>}
            </span>
            {isHer && !f.talent_response && (
              <form method="post" action={`/api/opportunities/${f.id}`} className="flex flex-wrap gap-2">
                <input type="hidden" name="action" value="answer" />
                <input type="hidden" name="back" value="/" />
                <button name="answer" value="interested" className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft">Interested</button>
                <button name="answer" value="pass" className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-ink/30">Pass</button>
                <Link href={`/opportunities/${f.id}#h-her`} className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-ink/30">
                  Questions
                </Link>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function describeChange(c: RecentChange): string {
  const d = c.detail;
  switch (c.kind) {
    case "change_detected":
      return `${String(d.field ?? "Details").replace("_", " ")} changed: ${String(d.from)} → ${String(d.to)}`;
    case "cancellation_detected":
      return "They cancelled or withdrew it";
    case "status_changed":
      return "They replied, so it's your turn";
    case "created":
      return "New offer found";
    default:
      return c.kind.replace(/_/g, " ");
  }
}
