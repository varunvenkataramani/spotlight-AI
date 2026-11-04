import type { Credibility, CheckResult } from "@/lib/ai/credibility.ts";
import { VERDICT_LABEL } from "@/lib/ai/credibility.ts";

export const VERDICT_CHIP: Record<Credibility["verdict"], string> = {
  genuine: "border border-ok/60 text-ok",
  careful: "border border-gel/60 text-gel",
  doubtful: "bg-alert text-stage",
};

const MARK: Record<CheckResult, { icon: string; className: string; sr: string }> = {
  pass: { icon: "✓", className: "text-ok", sr: "Passed" },
  warn: { icon: "!", className: "text-gel", sr: "Worth a look" },
  fail: { icon: "✕", className: "text-alert", sr: "Failed" },
  info: { icon: "·", className: "text-muted", sr: "For information" },
};

/** "Can we trust it?": each plain-rule check with its reason, and the two buttons. */
export function TrustPanel({
  id,
  credibility,
  senderList,
  back,
}: {
  id: string;
  credibility: Credibility | null;
  senderList: "trusted" | "blocked" | null;
  back: string;
}) {
  return (
    <section aria-labelledby="h-trust" id="trust" className="scroll-mt-24">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="h-trust" className="font-display text-xl font-semibold">
          Can we trust it?
        </h2>
        {credibility && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${VERDICT_CHIP[credibility.verdict]}`}>{VERDICT_LABEL[credibility.verdict]}</span>}
      </div>
      {credibility ? (
        <ul className="mt-3 space-y-2.5 text-sm">
          {credibility.checks.map((c) => (
            <li key={c.id} className="flex gap-3">
              <span aria-hidden="true" className={`w-4 shrink-0 text-center font-bold ${MARK[c.result].className}`}>
                {MARK[c.result].icon}
              </span>
              <span className="min-w-0">
                <span className="sr-only">{`${MARK[c.result].sr}: `}</span>
                <span className="font-medium">{c.label}</span>
                <span className="block leading-relaxed text-muted">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">The checks appear here once Spotlight has read this offer's emails.</p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        These checks show how the offer looks, not whether they'll pay. For a new name: ask for the brief on company letterhead, check their official site or
        Instagram, and never pay anything up front.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <form method="post" action={`/api/opportunities/${id}`}>
          <input type="hidden" name="action" value="trust" />
          <input type="hidden" name="on" value={senderList === "trusted" ? "0" : "1"} />
          <input type="hidden" name="back" value={back} />
          <button className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-ink/30">
            {senderList === "trusted" ? "Stop trusting this sender" : "Trust this sender"}
          </button>
        </form>
        {senderList !== "blocked" && (
          <form method="post" action={`/api/opportunities/${id}`}>
            <input type="hidden" name="action" value="not_genuine" />
            <button className="rounded-full border border-alert/50 px-4 py-2 text-sm font-medium text-alert hover:bg-alert/10">Not genuine</button>
          </form>
        )}
      </div>
      {senderList === "blocked" && <p className="mt-2 text-xs text-muted">This sender is marked not genuine. Undo it in Settings → Senders you've marked.</p>}
    </section>
  );
}
