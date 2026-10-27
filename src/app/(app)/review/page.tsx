import type { Metadata } from "next";
import { OpportunityCard } from "@/components/OpportunityCard";
import { Flash } from "@/components/detail";
import { EmptyState, PageHeader, formatIST } from "@/components/ui";
import { listOpportunities, listReviewEmails } from "@/server/opportunities.ts";

export const metadata: Metadata = { title: "Needs review" };

const CLASS_LABEL: Record<string, string> = {
  new_opportunity: "Possibly an offer",
  opportunity_update: "Possibly an update",
  negotiation_or_contract: "Possibly about terms",
  availability_request: "Possibly asking her dates",
  unrelated: "Probably not relevant",
  newsletter_or_spam: "Probably a newsletter",
  suspicious: "Possibly a scam",
  unclear: "Unclear",
};

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const { done, error } = await searchParams;
  const [opportunities, emails] = await Promise.all([listOpportunities({ onlyReview: true }), listReviewEmails()]);
  const aiOn = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const total = opportunities.length + emails.length;
  const failed = emails.filter((e) => e.processing_error?.startsWith("Couldn't be sorted automatically:")).length;

  return (
    <>
      <PageHeader
        title="Needs review"
        lead={
          total === 0
            ? "Nothing waiting. Anything the AI isn't sure about lands here instead of being dropped."
            : `${total} ${total === 1 ? "item needs" : "items need"} a person to look. Your choices also teach future sorting.`
        }
      />
      <Flash done={done} error={error} />

      {failed > 0 && aiOn && (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gel/60 bg-gel-soft/40 px-5 py-4">
          <p className="max-w-2xl text-sm leading-relaxed">
            {`${failed} ${failed === 1 ? "email wasn't" : "emails weren't"} sorted because of a problem reaching Claude, not because the AI was unsure.`}
          </p>
          <form method="post" action="/api/emails/retry">
            <button className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft">Sort them again</button>
          </form>
        </div>
      )}

      {total === 0 && (
        <EmptyState title="Nothing to review">
          When an email might be an offer but the AI isn't confident, or an offer shows possible scam signs, it appears here with
          the reason.
        </EmptyState>
      )}

      {opportunities.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 font-display text-xl font-semibold">Offers to check</h2>
          <div className="space-y-4">
            {opportunities.map((o) => (
              <OpportunityCard key={o.id} o={o} />
            ))}
          </div>
        </section>
      )}

      {emails.length > 0 && (
        <section>
          <h2 className="mb-4 font-display text-xl font-semibold">Emails the AI wasn't sure about</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {emails.map((e) => {
              const confidence = e.classification_confidence === null ? null : Math.round(Number(e.classification_confidence) * 100);
              return (
                <li key={e.id} className="grid gap-1 px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate font-medium">{e.subject || "(no subject)"}</p>
                    <time className="text-sm tabular-nums text-muted" dateTime={e.received_at.toISOString()}>
                      {formatIST(e.received_at)}
                    </time>
                  </div>
                  <p className="truncate text-sm text-muted">{e.from_name ? `${e.from_name} · ${e.from_email}` : e.from_email}</p>
                  <p className="text-sm">
                    <span className="font-medium">
                      {e.classification ? (CLASS_LABEL[e.classification] ?? e.classification) : "Not sorted"}
                      {confidence !== null && ` (${confidence}% sure)`}:
                    </span>{" "}
                    {e.processing_error ?? e.classification_reason ?? "No reason given."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <form method="post" action={`/api/emails/${e.id}`}>
                      <input type="hidden" name="decision" value="offer" />
                      <button className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-paper hover:bg-ink-soft">
                        {aiOn ? "It's an offer: read it again" : "It's an offer: make a card"}
                      </button>
                    </form>
                    <form method="post" action={`/api/emails/${e.id}`}>
                      <input type="hidden" name="decision" value="not_offer" />
                      <button className="rounded-full border border-line px-4 py-1.5 text-sm font-medium hover:border-ink/30">Not an offer</button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
