import type { Metadata } from "next";
import Link from "next/link";
import { OpportunityCard } from "@/components/OpportunityCard";
import { EmptyState, PageHeader } from "@/components/ui";
import { getInboxStatus } from "@/server/gmail.ts";
import { getAiOverview, listOpportunities } from "@/server/opportunities.ts";

export const metadata: Metadata = { title: "Opportunities" };

export default async function OpportunitiesPage() {
  const [opportunities, ai, inbox] = await Promise.all([listOpportunities(), getAiOverview(), getInboxStatus()]);

  const lead =
    opportunities.length > 0
      ? `${opportunities.length} ${opportunities.length === 1 ? "offer" : "offers"}, most urgent first. Each card is one project, however many emails it took.`
      : "Every offer, one card per project, however many emails it took.";

  return (
    <>
      <PageHeader title="Opportunities" lead={lead} />

      {ai.waiting > 0 && ai.keyConfigured && (
        <p role="status" className="mb-6 text-sm text-muted">
          {ai.waiting} {ai.waiting === 1 ? "email is" : "emails are"} still being sorted. This page shows new offers when you reload it.
        </p>
      )}

      {opportunities.length > 0 ? (
        <div className="space-y-4">
          {opportunities.map((o) => (
            <OpportunityCard key={o.id} o={o} />
          ))}
        </div>
      ) : !inbox ? (
        <EmptyState title="No inbox connected">
          Connect Gmail in{" "}
          <Link className="underline decoration-gel decoration-2 underline-offset-4" href="/settings#gmail">
            Settings
          </Link>
          . Offers found in the inbox appear here as cards.
        </EmptyState>
      ) : !ai.keyConfigured ? (
        <EmptyState title="AI sorting is off">
          Spotlight has read {inbox.storedTotal} emails but can't sort them yet. Add ANTHROPIC_API_KEY in Vercel's environment
          variables and redeploy; sorting starts within a minute.
        </EmptyState>
      ) : (
        <EmptyState title="No offers found yet">
          {ai.waiting > 0
            ? `Spotlight is sorting ${ai.waiting} emails. Offers appear here as they're found.`
            : "Nothing in the inbox looks like an offer so far. Emails the AI wasn't sure about are in Needs review."}
        </EmptyState>
      )}
    </>
  );
}
