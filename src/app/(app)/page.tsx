import type { Metadata } from "next";
import Link from "next/link";
import { Flash } from "@/components/detail";
import { ErrorPanel, PageHeader, StatusDot, formatIST } from "@/components/ui";
import { getInboxStatus, type InboxStatus } from "@/server/gmail.ts";
import { getOverviewCounts, listFlagged, listRunway, type FlaggedItem, type OverviewCounts, type RunwayMark } from "@/server/overview.ts";
import { requireAdmin } from "@/server/session.ts";
import { listOpportunities, listRecentChanges, type OpportunityCard, type RecentChange } from "@/server/opportunities.ts";
import { formatDay, payText } from "@/lib/format.ts";

export const metadata: Metadata = { title: "Stage" };

const TODAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });
const DOW = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" });
const DAYNUM = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric" });
const DAY_MS = 86_400_000;
const istDay = (d: Date) => Math.floor((d.getTime() + 5.5 * 3_600_000) / DAY_MS);

/** How far along the "light" bar reaches: the more it matters, the longer the light. */
const LIGHT: Record<OpportunityCard["priority"], string> = { high: "100%", needs_review: "70%", medium: "52%", low: "22%" };
const KIND_LABEL: Record<OpportunityCard["priority"], string> = { high: "High priority", needs_review: "Check this", medium: "Medium", low: "Low" };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const { done, error: actionError } = await searchParams;
  const me = await requireAdmin();
  let counts: OverviewCounts;
  let inbox: InboxStatus | null;
  let now: OpportunityCard[];
  let open: OpportunityCard[];
  let changes: RecentChange[];
  let flagged: { items: FlaggedItem[]; talentEmail: string | null };
  let runway: RunwayMark[];
  try {
    [counts, inbox, now, open, changes, flagged, runway] = await Promise.all([
      getOverviewCounts(),
      getInboxStatus(),
      listOpportunities({ attention: true, limit: 8 }),
      listOpportunities({ limit: 24 }),
      listRecentChanges(6),
      listFlagged(),
      listRunway(14),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    const busy = /EMAXCONN|max clients|too many clients|timeout exceeded when trying to connect/i.test(reason);
    console.error("Overview failed:", reason);
    return (
      <>
        <PageHeader title="Stage" />
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

  const isHer = flagged.talentEmail === me.email;
  const waitingForHer = flagged.items.filter((f) => !f.talent_response);
  const lead = flagged.items.length > 0 && isHer && waitingForHer.length > 0;
  const hero = now[0] ?? null;
  const notSnoozed = (o: OpportunityCard) => !o.snoozed_until || o.snoozed_until.getTime() <= Date.now();
  const wings = [...now.slice(1), ...open.filter((o) => notSnoozed(o) && !now.some((n) => n.id === o.id))].slice(0, 8);

  const headline = isHer && waitingForHer.length > 0
    ? `${waitingForHer.length} ${waitingForHer.length === 1 ? "offer is" : "offers are"} waiting for your answer.`
    : !inbox
      ? "Connect Gmail to light the stage."
      : now.length === 0
        ? "Nothing needs you right now."
        : now.length === 1
          ? "One offer needs you."
          : `${now.length} offers need you. This one first.`;

  return (
    <>
      <p className="text-sm uppercase tracking-[0.12em] text-muted">{TODAY.format(new Date())}</p>
      <h1 className="mt-1.5 font-display text-4xl font-semibold tracking-tight text-balance md:text-5xl">{headline}</h1>
      <div className="mt-6">
        <Flash done={done} error={actionError} />
      </div>

      {lead && <HerCalls items={flagged.items} isHer={isHer} />}

      <section aria-labelledby="h-now" className="relative mt-2 overflow-hidden rounded-[28px] bg-surface/60 px-4 pb-14 pt-16 md:px-6 md:pt-20">
        <div className="beam" aria-hidden="true" />
        <div className="beam-floor" aria-hidden="true" />
        <h2 id="h-now" className="sr-only">
          Needs you now
        </h2>
        {hero ? <Spotlit o={hero} /> : <EmptyStage connected={Boolean(inbox)} />}
      </section>

      {!lead && flagged.items.length > 0 && <HerCalls items={flagged.items} isHer={isHer} />}

      <section aria-labelledby="h-wings" className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="h-wings" className="font-display text-2xl font-semibold">
            In the wings
          </h2>
          <Link href="/opportunities" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
            All offers
          </Link>
        </div>
        {wings.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Other open offers line up here, the most important first.</p>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {wings.map((o) => (
              <li key={o.id}>
                <Link data-stage={o.id} href={`/opportunities/${o.id}`} className="relative block h-full overflow-hidden rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-ink/30">
                  <span aria-hidden="true" className={`absolute left-0 top-0 h-[3px] ${o.priority === "needs_review" ? "bg-alert" : "bg-gel"}`} style={{ width: LIGHT[o.priority] }} />
                  <span className="block text-xs uppercase tracking-[0.08em] text-muted">{o.category_name ?? KIND_LABEL[o.priority]}</span>
                  <span className="mt-2 block font-display text-xl font-semibold leading-snug tracking-tight">{o.title}</span>
                  <span className="mt-0.5 block truncate text-sm text-muted">{o.organization ?? o.sender_name ?? o.sender_email}</span>
                  <span className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
                    <span className="font-semibold tabular-nums">{payText(o)}</span>
                    {o.next_deadline_at && <span className="text-muted">{formatDay(o.next_deadline_at)}</span>}
                  </span>
                  {!o.is_read && <span className="mt-3 inline-block rounded-full bg-ink px-2 py-0.5 text-xs font-semibold text-paper">Unread</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Runway marks={runway} />

      <section className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0 rounded-2xl border border-line bg-surface p-6">
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
                  <span className="block text-muted">{`${describeChange(c)} · ${formatDay(c.created_at)}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 space-y-6">
          <div className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="font-display text-xl font-semibold">Tonight's numbers</h2>
            <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
              {[
                ["High priority", counts.highPriority],
                ["Need a reply", counts.needsReply],
                ["Due in 7 days", counts.dueThisWeek],
                ["New", counts.newOpportunities],
                ["Drafts", counts.draftsToReview],
                ["To check", counts.needsReview],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dd className={`font-display text-3xl font-semibold tabular-nums ${value === 0 ? "text-muted" : ""}`}>{value}</dd>
                  <dt className="text-muted">{label}</dt>
                </div>
              ))}
            </dl>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 text-sm">
            <h2 className="font-display text-xl font-semibold">Inbox</h2>
            {inbox ? (
              <p className="mt-3 flex items-start gap-2 text-muted">
                <span className="mt-1.5">
                  <StatusDot tone={inbox.status === "connected" ? (inbox.consecutiveFailures >= 3 ? "warn" : "ok") : "bad"} />
                </span>
                <span>
                  <span className="text-ink">{inbox.email}</span>
                  {inbox.status === "connected" ? ` · checked ${formatIST(inbox.lastSyncedAt)}` : " · needs reconnecting"}
                </span>
              </p>
            ) : (
              <p className="mt-3 text-muted">Not connected. Once Gmail is connected, new mail is read within a minute, even with this page closed.</p>
            )}
            <Link href={inbox?.status === "connected" ? "/mail" : "/settings#gmail"} className="mt-3 inline-block font-medium underline decoration-gel decoration-2 underline-offset-4">
              {inbox ? (inbox.status === "connected" ? "See synced mail" : "Reconnect in Settings") : "Connect Gmail"}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

/** The one offer in the light: what it is, what it pays, why it's lit, and time left. */
function Spotlit({ o }: { o: OpportunityCard }) {
  const due = o.next_deadline_at;
  const msLeft = due ? due.getTime() - Date.now() : null;
  const isReply = Boolean(due && o.reply_by_at && o.reply_by_at.getTime() === due.getTime());
  const days = msLeft !== null ? Math.max(0, Math.floor(msLeft / DAY_MS)) : null;
  const hours = msLeft !== null ? Math.max(0, Math.floor((msLeft % DAY_MS) / 3_600_000)) : null;
  const R = 70;
  const C = 2 * Math.PI * R;
  const remaining = msLeft === null ? 0 : Math.max(0, Math.min(1, msLeft / (7 * DAY_MS)));
  const what = o.deliverables.length ? o.deliverables.map((d) => d.item).join(" + ") : (o.summary ?? "");

  return (
    <article data-stage={o.id} className="relative mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-8 rounded-3xl bg-ink px-7 py-8 text-stage md:px-10 md:py-9">
      <div className="min-w-0 flex-[1_1_320px]">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          <span className={`rounded-full px-2.5 py-1 tracking-wide ${o.priority === "needs_review" ? "bg-alert text-stage" : "bg-stage text-gel"}`}>
            {KIND_LABEL[o.priority].toUpperCase()}
          </span>
          {o.category_name && <span className="text-stage/70">{o.category_name}</span>}
          {!o.is_read && <span className="text-stage/70">· unread</span>}
        </div>
        <p className="mt-4 font-display text-4xl font-bold leading-none tracking-tight text-balance md:text-5xl">{o.title}</p>
        <p className="mt-2 text-base text-stage/70">{[o.organization ?? o.sender_name, what, o.location].filter(Boolean).join(" · ")}</p>
        <p className="mt-5 font-display text-3xl font-semibold tracking-tight tabular-nums md:text-4xl">{payText(o)}</p>
        {o.priority_reasons.length > 0 && (
          <p className="mt-3 text-sm leading-relaxed text-stage/70">{`Lit because: ${o.priority_reasons.slice(0, 3).join(" · ")}`}</p>
        )}
        {o.red_flags.length > 0 && <p className="mt-2 text-sm font-semibold text-[#b3261e]">{`Warning signs: ${o.red_flags.map((f) => f.flag).slice(0, 2).join("; ")}`}</p>}
        <div className="mt-6 flex flex-wrap gap-2.5">
          <Link href={`/opportunities/${o.id}`} className="inline-flex min-h-11 items-center rounded-full bg-stage px-5 text-[15px] font-semibold text-ink hover:bg-raised">
            Open
          </Link>
          <Link href={`/opportunities/${o.id}#reply`} className="inline-flex min-h-11 items-center rounded-full border border-stage px-5 text-[15px] font-semibold hover:bg-stage/5">
            Draft a reply
          </Link>
          <Link href={`/opportunities/${o.id}#h-her`} className="inline-flex min-h-11 items-center px-3 text-[15px] font-semibold underline underline-offset-4">
            Ask her
          </Link>
        </div>
      </div>
      {due && msLeft !== null && msLeft > 0 && (
        <div className="flex flex-col items-center gap-1.5">
          <svg role="img" aria-label={`${days} days and ${hours} hours left`} width="164" height="164" viewBox="0 0 164 164">
            <circle cx="82" cy="82" r={R} fill="none" stroke="#dcd8cc" strokeWidth="10" />
            <circle
              cx="82"
              cy="82"
              r={R}
              fill="none"
              stroke="#0e0d14"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - remaining)}
              transform="rotate(-90 82 82)"
            />
            <text x="82" y="86" textAnchor="middle" className="font-display" fontSize="36" fontWeight="700" fill="#0e0d14">
              {days! > 0 ? `${days}d ${hours}h` : `${hours}h`}
            </text>
            <text x="82" y="110" textAnchor="middle" fontSize="13" fill="#4f4b5e">
              {isReply ? "to reply" : "to go"}
            </text>
          </svg>
          <span className="text-sm text-stage/70">{`${isReply ? "Reply by" : "Next date"} ${formatDay(due)}`}</span>
        </div>
      )}
    </article>
  );
}

function EmptyStage({ connected }: { connected: boolean }) {
  return (
    <div className="relative mx-auto max-w-xl py-10 text-center">
      <p className="font-display text-3xl font-semibold tracking-tight">The stage is clear.</p>
      <p className="mt-3 leading-relaxed text-muted">
        {connected
          ? "When an offer needs you, high priority, due within a week, or unread, it steps into the light here."
          : "Connect her Gmail in Settings. New offers will step into the light here within a minute of arriving."}
      </p>
      {!connected && (
        <Link href="/settings#gmail" className="mt-6 inline-flex min-h-11 items-center rounded-full bg-gel px-5 font-semibold text-stage">
          Connect Gmail
        </Link>
      )}
    </div>
  );
}

/** The next 14 days: reply-by dates and shoots, laid out like a runway. */
function Runway({ marks }: { marks: RunwayMark[] }) {
  const today = istDay(new Date());
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = new Date((today + i) * DAY_MS + 6 * 3_600_000);
    return { i, date, marks: marks.filter((m) => istDay(m.at) === today + i) };
  });
  return (
    <section aria-labelledby="h-runway" className="mt-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="h-runway" className="font-display text-2xl font-semibold">
          The runway
        </h2>
        <span className="flex gap-5 text-sm text-muted">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-gel" />
            Reply due
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 rotate-45 bg-ink" />
            Shoot or event
          </span>
        </span>
      </div>
      <div className="mt-4 overflow-x-auto">
        <ol className="grid min-w-[980px] grid-cols-[repeat(14,minmax(0,1fr))] border-t border-line">
          {days.map((d) => (
            <li key={d.i} className={`min-h-32 border-l border-line/60 px-2 pb-3 pt-3 ${d.i === 0 ? "bg-surface" : ""}`}>
              <p className="text-xs uppercase tracking-[0.06em] text-muted">{d.i === 0 ? "Today" : DOW.format(d.date)}</p>
              <p className={`font-display text-xl font-semibold ${d.i === 0 ? "text-gel" : ""}`}>{DAYNUM.format(d.date)}</p>
              <ul className="mt-2 space-y-2">
                {d.marks.map((m) => (
                  <li key={`${m.id}-${m.kind}`}>
                    <Link href={`/opportunities/${m.id}`} className="flex items-start gap-1.5 text-xs leading-snug hover:text-gel">
                      <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 ${m.kind === "reply" ? "rounded-full bg-gel" : "rotate-45 bg-ink"}`} />
                      <span>{`${m.kind === "reply" ? "Reply" : "On"} · ${m.organization ?? m.title}`}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
      {marks.length === 0 && <p className="mt-3 text-sm text-muted">Reply-by dates and shoots in the next two weeks appear on the runway as offers come in.</p>}
    </section>
  );
}

const ANSWER = { interested: "Interested", pass: "Pass", questions: "Has questions" } as const;

/** For her: the next offer put to her, big, with the answers right there. For the team: what she said. */
function HerCalls({ items, isHer }: { items: FlaggedItem[]; isHer: boolean }) {
  const waiting = items.filter((f) => !f.talent_response);
  const next = isHer ? waiting[0] : undefined;
  const rest = items.filter((f) => f !== next);
  return (
    <section aria-labelledby="h-call" className="my-8 rounded-[28px] border border-gel/40 bg-gel-soft p-6 md:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="h-call" className="font-display text-2xl font-semibold">
          {isHer ? "Your call" : "Her call"}
        </h2>
        {isHer && waiting.length > 0 && <span className="text-sm text-muted">{`${waiting.length} waiting`}</span>}
      </div>
      {next && (
        <div className="mt-5 rounded-3xl border border-line bg-surface p-6">
          <p className="text-xs uppercase tracking-[0.1em] text-gel">Waiting for your answer</p>
          <p className="mt-2 font-display text-3xl font-bold tracking-tight">{next.title}</p>
          {next.organization && <p className="mt-1 text-muted">{next.organization}</p>}
          <form method="post" action={`/api/opportunities/${next.id}`} className="mt-6 grid grid-cols-3 gap-2.5">
            <input type="hidden" name="action" value="answer" />
            <input type="hidden" name="back" value="/" />
            <button name="answer" value="pass" className="min-h-14 rounded-2xl border border-line text-base font-semibold hover:border-ink/40">
              Pass
            </button>
            <Link href={`/opportunities/${next.id}#h-her`} className="flex min-h-14 items-center justify-center rounded-2xl border border-line text-base font-semibold hover:border-ink/40">
              Questions
            </Link>
            <button name="answer" value="interested" className="min-h-14 rounded-2xl bg-gel text-base font-bold text-stage">
              Interested
            </button>
          </form>
        </div>
      )}
      {rest.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {rest.map((f) => (
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
            </li>
          ))}
        </ul>
      )}
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
