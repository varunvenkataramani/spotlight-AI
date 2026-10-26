// Building blocks of the opportunity detail page. Plain server-rendered forms: no client code needed.
import { formatDay } from "@/lib/format.ts";
import { highlight } from "@/lib/highlight.ts";
import { STATUS_LABEL, type Status } from "@/lib/edits.ts";
import type { FieldSource, ThreadEmail, TimelineItem } from "@/server/opportunity-detail.ts";

export const BUTTON = "rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft";
export const BUTTON_QUIET = "rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-ink/30";
export const INPUT = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";

export function Flash({ done, error }: { done?: string; error?: string }) {
  if (!done && !error) return null;
  return (
    <p
      role={error ? "alert" : "status"}
      className={`mb-6 rounded-lg px-4 py-3 text-sm ${error ? "border border-alert/40 bg-alert/5 text-alert" : "border border-ok/40 bg-ok/5"}`}
    >
      {error ?? done}
    </p>
  );
}

export function ActionForm({
  id,
  action,
  children,
  className,
}: {
  id: string;
  action: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <form method="post" action={`/api/opportunities/${id}`} className={className}>
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}

/** Where a value came from: the email's own words, a person's correction, or a warning that it couldn't be matched. */
export function Source({ source, unverified }: { source?: FieldSource; unverified: boolean }) {
  if (source?.corrected_by_name) return <p className="mt-1 text-xs text-muted">{`Corrected by ${source.corrected_by_name}`}</p>;
  if (unverified || (source && !source.is_verified)) {
    return (
      <p className="mt-1 text-xs text-alert">
        Couldn't match this to the email's exact words. Check it before relying on it.
        {source?.source_quote && <span className="text-muted">{` The AI quoted: “${source.source_quote}”`}</span>}
      </p>
    );
  }
  if (source?.source_quote) return <p className="mt-1 text-xs text-muted">{`From the email: “${source.source_quote}”`}</p>;
  return null;
}

export function FieldRow({
  label,
  value,
  source,
  unverified = false,
  children,
}: {
  label: string;
  value: React.ReactNode;
  source?: FieldSource;
  unverified?: boolean;
  children?: React.ReactNode;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="min-w-0">
        <div className={empty ? "text-muted" : ""}>{empty ? "Not stated" : value}</div>
        <Source source={source} unverified={unverified} />
        {children && (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-muted underline-offset-4 hover:text-ink hover:underline">Edit</summary>
            <div className="mt-2 rounded-xl border border-line p-3">{children}</div>
          </details>
        )}
      </dd>
    </div>
  );
}

const ROLE: Record<string, string> = {
  original: "First email",
  follow_up: "Follow-up",
  change: "Changed details",
  contract: "About terms",
  cancellation: "Cancellation",
  other: "In the thread",
};

export function EmailCard({ email, quotes }: { email: ThreadEmail; quotes: string[] }) {
  const body = email.body_text ?? "";
  const long = body.length > 6000;
  const render = (text: string) =>
    highlight(text, quotes).map((s, i) =>
      s.mark ? (
        <mark key={i} className="rounded-sm bg-gel-soft px-0.5 text-ink">
          {s.text}
        </mark>
      ) : (
        <span key={i}>{s.text}</span>
      ),
    );
  return (
    <article className="rounded-2xl border border-line bg-surface">
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 truncate font-medium">{email.from_name ?? email.from_email ?? "Unknown sender"}</p>
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">{ROLE[email.role] ?? email.role}</span>
        </div>
        {email.from_name && <p className="truncate text-xs text-muted">{email.from_email}</p>}
        <p className="mt-2 text-sm font-medium">{email.subject || "(no subject)"}</p>
        <p className="text-xs text-muted tabular-nums">
          {formatDay(email.received_at, true)}
          {email.linked_by === "admin" && " · added by her team"}
          {email.linked_by === "ai_match" && " · linked by matching sender"}
        </p>
        {email.attachment_names.length > 0 && (
          <p className="mt-1 text-xs text-muted">Attachments: {email.attachment_names.join(", ")}</p>
        )}
      </header>
      <div className="px-5 py-4">
        {long ? (
          <>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{render(body.slice(0, 6000))}</p>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-muted">Show the rest of the email</summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{render(body.slice(6000))}</p>
            </details>
          </>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body ? render(body) : <span className="text-muted">(no text)</span>}</p>
        )}
      </div>
    </article>
  );
}

const statusLabel = (s: unknown) => STATUS_LABEL[s as Status] ?? String(s ?? "");
const str = (v: unknown) => String(v ?? "");

function describe(item: TimelineItem): React.ReactNode {
  const who = item.actor_type === "user" ? (item.actor_name ?? "Her team") : item.actor_type === "ai" ? "AI" : "Spotlight";
  const d = item.detail;
  switch (item.kind) {
    case "created":
      return "Found in the inbox and turned into this card";
    case "created_by_admin":
      return `${who} made this card from an email`;
    case "change_detected":
      return (
        <>
          Their email changed <b>{str(d.field).replace("_", " ")}</b>: {str(d.from)} → {str(d.to)}
          {d.verified === false && <span className="text-alert"> (not matched to the email's words)</span>}
        </>
      );
    case "cancellation_detected":
      return "Their email cancels or withdraws this offer";
    case "email_received":
      return "New email in the conversation";
    case "status_changed":
      return d.because ? `Status changed to ${statusLabel(d.to)}: ${str(d.because).toLowerCase()}` : `${who} changed the status: ${statusLabel(d.from)} → ${statusLabel(d.to)}`;
    case "note":
      return (
        <>
          <span className="font-medium">{who}</span>: <span className="whitespace-pre-wrap">{str(d.text)}</span>
        </>
      );
    case "corrected":
      return `${who} corrected ${str(d.field).toLowerCase()}: ${str(d.from)} → ${str(d.to)}`;
    case "snoozed":
      return `${who} snoozed it for ${str(d.days)} day${d.days === 1 ? "" : "s"}`;
    case "unsnoozed":
      return `${who} brought it back from snooze`;
    case "review_cleared":
      return `${who} checked it and confirmed it's genuine`;
    case "marked_not_relevant":
      return `${who} marked it not relevant`;
    case "restored":
      return `${who} put it back in the lists`;
    case "merged":
      return `${who} merged in “${str(d.fromTitle)}” (${str(d.emails)} email${d.emails === 1 ? "" : "s"})`;
    case "duplicate_dismissed":
      return `${who} kept it separate from a similar offer`;
    case "possible_duplicate":
      return "Looks similar to another offer from the same sender";
    case "flagged_for_her":
      return d.note ? `${who} sent it to her: “${str(d.note)}”` : `${who} sent it to her for an answer`;
    case "flag_withdrawn":
      return `${who} withdrew the question to her`;
    case "her_answer": {
      const label = { interested: "Interested", pass: "Pass", questions: "Has questions" }[str(d.answer)] ?? str(d.answer);
      const via = d.via === "telegram" ? " (in Telegram)" : "";
      return (
        <>
          <span className="font-medium">{who}</span> answered: {label}
          {via}
          {d.note ? <span className="block whitespace-pre-wrap">“{str(d.note)}”</span> : null}
        </>
      );
    }
    case "reminder_set":
      return `${who} set a reminder for ${typeof d.at === "string" ? WHEN.format(new Date(d.at)) : "later"}${d.forBoth ? " for both" : ""}${d.note ? `: ${str(d.note)}` : ""}`;
    case "reminder_cancelled":
      return `${who} cancelled a reminder`;
    case "linked_by_sender":
      return "An email was linked because it's from the same sender. Check it belongs here.";
    default:
      return item.kind.replace(/_/g, " ");
  }
}

const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted">Nothing has happened yet.</p>;
  return (
    <ol className="space-y-3 border-l border-line pl-4">
      {items.map((item) => (
        <li key={item.id} className="relative text-sm">
          <span
            aria-hidden="true"
            className={`absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full ${item.actor_type === "user" ? "bg-ink" : item.actor_type === "ai" ? "bg-gel" : "bg-line"}`}
          />
          <p className="leading-relaxed">{describe(item)}</p>
          <p className="text-xs text-muted tabular-nums">{WHEN.format(item.created_at)}</p>
        </li>
      ))}
    </ol>
  );
}
