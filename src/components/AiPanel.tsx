import { StatusDot } from "@/components/ui";
import type { AiOverview } from "@/server/opportunities.ts";

const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

export function AiPanel({ ai }: { ai: AiOverview }) {
  const problem = ai.status?.state === "account_problem" || ai.status?.state === "failed";
  const tone = !ai.keyConfigured ? "idle" : problem ? "bad" : ai.retrying > 0 ? "warn" : "ok";
  const headline = !ai.keyConfigured
    ? "Off. Add ANTHROPIC_API_KEY in Vercel's environment variables and redeploy to start sorting."
    : problem
      ? (ai.status?.message ?? "The last sorting run had a problem.")
      : ai.waiting > 0
        ? `Sorting: ${ai.waiting} ${ai.waiting === 1 ? "email" : "emails"} waiting.`
        : "On. New mail is sorted within a minute or two.";

  return (
    <section className="rounded-2xl border border-line bg-surface p-6">
      <h2 className="font-display text-xl font-semibold">AI sorting</h2>
      <p className="mt-3 flex items-start gap-3 text-sm">
        <span className="mt-1.5">
          <StatusDot tone={tone} />
        </span>
        <span className={problem ? "text-alert" : ""}>{headline}</span>
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line text-sm sm:grid-cols-4">
        {[
          ["Sorted", ai.sorted],
          ["Offers found", ai.opportunities],
          ["Need review", ai.needsReview],
          ["Retrying", ai.retrying],
        ].map(([label, value]) => (
          <div key={label as string} className="bg-surface px-4 py-3">
            <dd className="font-display text-2xl font-semibold tabular-nums">{value}</dd>
            <dt className="text-muted">{label}</dt>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Last 30 days: {ai.calls30d} AI calls, {compact.format(ai.inputTokens30d)} tokens read and{" "}
        {compact.format(ai.outputTokens30d)} written. A quick model checks every email; a stronger one reads only likely offers.
        Email text is sent to Claude for this and isn't used to train models.
      </p>
    </section>
  );
}
