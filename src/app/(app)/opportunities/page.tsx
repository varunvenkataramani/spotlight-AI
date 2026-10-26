import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Opportunities" };

export default function OpportunitiesPage() {
  return (
    <>
      <PageHeader title="Opportunities" lead="Every offer, one card per project, however many emails it took." />
      <EmptyState title="No opportunities yet">
        Offers appear here once Gmail is connected and the first emails are read. You'll be able to filter by category,
        priority, pay and deadline, and open each one beside its original email.
      </EmptyState>
    </>
  );
}
