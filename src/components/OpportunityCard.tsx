import Link from "next/link";
import { payText } from "@/lib/format.ts";
import type { OpportunityCard as Card } from "@/server/opportunities.ts";

const PRIORITY: Record<Card["priority"], { label: string; className: string }> = {
  high: { label: "High priority", className: "bg-gel text-stage" },
  needs_review: { label: "Check this", className: "border border-alert/60 text-alert" },
  medium: { label: "Medium", className: "border border-ink/25 text-ink" },
  low: { label: "Low", className: "border border-line text-muted" },
};

const FIELD_NAMES: Record<string, string> = {
  compensation: "pay",
  dates: "dates",
  deliverables: "deliverables",
  organization: "company",
  sender_role: "sender's role",
  contact_phone: "phone",
  offer: "offer",
  usage_rights: "usage rights",
  exclusivity: "exclusivity",
  expenses_covered: "expenses",
  location: "location",
  requested_action: "next step",
};

/** The light along the top of a card: longer and brighter the more it matters. */
const LIGHT: Record<Card["priority"], { width: string; className: string }> = {
  high: { width: "100%", className: "bg-gel" },
  needs_review: { width: "70%", className: "bg-alert" },
  medium: { width: "50%", className: "bg-gel/70" },
  low: { width: "20%", className: "bg-gel/40" },
};

const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

function dateText(o: Card): string | null {
  if (o.next_deadline_at) {
    const isReply = o.reply_by_at && o.reply_by_at.getTime() === o.next_deadline_at.getTime();
    return `${isReply ? "Reply by" : "Next date"} ${DAY.format(o.next_deadline_at)}`;
  }
  if (o.event_start_at) return `Was on ${DAY.format(o.event_start_at)}`;
  if (o.reply_by_at) return `Reply was due ${DAY.format(o.reply_by_at)}`;
  return null;
}

export function OpportunityCard({ o }: { o: Card }) {
  const p = PRIORITY[o.priority];
  const who = [o.organization, o.sender_name && o.sender_name !== o.organization ? o.sender_name : null].filter(Boolean).join(" · ");
  const date = dateText(o);
  const unverified = o.unverified_fields.map((f) => FIELD_NAMES[f] ?? f);
  const emails = Number(o.email_count);
  const highFlags = o.red_flags.filter((f) => f.severity === "high");
  const lowFlags = o.red_flags.filter((f) => f.severity === "low");

  return (
    <article className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 md:p-6">
      <span aria-hidden="true" className={`absolute left-0 top-0 h-[3px] ${LIGHT[o.priority].className}`} style={{ width: LIGHT[o.priority].width }} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2.5 py-1 font-semibold ${p.className}`}>{p.label}</span>
        {o.category_name && <span className="text-muted">{o.category_name}</span>}
        {o.from_historical && <span className="rounded-full border border-line px-2 py-0.5 text-muted">Earlier mail</span>}
        {emails > 1 && <span className="text-muted">· {emails} emails</span>}
        {!o.is_read && <span className="rounded-full bg-ink px-2 py-0.5 font-semibold text-paper">Unread</span>}
        {o.snoozed_until && o.snoozed_until.getTime() > Date.now() && <span className="rounded-full border border-line px-2 py-0.5 text-muted">Snoozed</span>}
      </div>

      <h2 className="mt-3 font-display text-xl font-semibold leading-snug text-balance">
        <Link href={`/opportunities/${o.id}`} className="decoration-gel decoration-2 underline-offset-4 hover:underline">
          {o.title}
        </Link>
      </h2>
      {who && <p className="mt-0.5 text-sm text-muted">{who}</p>}
      {o.summary && <p className="mt-3 max-w-3xl leading-relaxed">{o.summary}</p>}

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="sr-only">Pay</dt>
          <dd className="font-semibold tabular-nums">{payText(o)}</dd>
        </div>
        {date && (
          <div>
            <dt className="sr-only">Date</dt>
            <dd className="tabular-nums">{date}</dd>
          </div>
        )}
        {o.deliverables.length > 0 && (
          <div className="min-w-0">
            <dt className="sr-only">Deliverables</dt>
            <dd className="text-muted">{o.deliverables.map((d) => d.item).join(", ")}</dd>
          </div>
        )}
        {o.location && (
          <div>
            <dt className="sr-only">Location</dt>
            <dd className="text-muted">{o.location}</dd>
          </div>
        )}
      </dl>

      {highFlags.length + lowFlags.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-sm" aria-label="Warning signs">
          {[...highFlags, ...lowFlags].map((f) => (
            <li key={f.flag} className={`flex gap-2 ${f.severity === "high" ? "text-alert" : "text-muted"}`}>
              <span aria-hidden="true">{f.severity === "high" ? "▲" : "△"}</span>
              <span className="min-w-0">
                {f.flag}
                {f.evidence && <span className="text-muted"> · “{f.evidence}”</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {o.priority_reasons.length > 0 && (
        <p className="mt-4 text-sm text-muted">
          <span className="font-medium text-ink">Why: </span>
          {o.priority_reasons.slice(0, 4).join(" · ")}
        </p>
      )}

      {(unverified.length > 0 || o.possible_duplicate_title) && (
        <div className="mt-3 space-y-1 text-xs text-muted">
          {unverified.length > 0 && <p>Couldn't match to the email's exact words, so double-check: {unverified.join(", ")}.</p>}
          {o.possible_duplicate_title && <p>Might be the same offer as “{o.possible_duplicate_title}”.</p>}
        </div>
      )}
    </article>
  );
}
