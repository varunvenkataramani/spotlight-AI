import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Needs review" };

export default function ReviewPage() {
  return (
    <>
      <PageHeader title="Needs review" lead="Emails the AI wasn't sure about. Nothing uncertain is ever silently discarded." />
      <EmptyState title="Nothing to review">
        When an email might be an opportunity but the AI's confidence is low, it lands here with its reasoning. One click
        files it as an opportunity or marks it as not relevant, and that choice teaches future sorting.
      </EmptyState>
    </>
  );
}
