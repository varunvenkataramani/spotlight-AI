// The "Reply" section of an offer: ask Claude for a draft, edit it, then save it to Gmail or send it
// after confirming. Plain forms; nothing is sent without the confirmation box ticked.
import Link from "next/link";
import { ActionForm, BUTTON, BUTTON_QUIET, INPUT } from "@/components/detail";
import { DRAFT_MODES, MODE_LABEL, TONES, TONE_LABEL, placeholdersIn } from "@/lib/ai/draft.ts";
import type { DraftView } from "@/server/drafts.ts";

const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function ReplyPanel({
  oppId,
  drafts,
  canWrite,
  inboxEmail,
  aiOn,
  hasEmail,
}: {
  oppId: string;
  drafts: DraftView[];
  canWrite: boolean;
  inboxEmail: string | null;
  aiOn: boolean;
  hasEmail: boolean;
}) {
  return (
    <section id="reply" aria-labelledby="h-reply" className="scroll-mt-8">
      <h2 id="h-reply" className="font-display text-xl font-semibold">Reply</h2>
      {!aiOn ? (
        <p className="mt-2 text-sm text-muted">Reply drafts need AI to be on. Add ANTHROPIC_API_KEY in Vercel.</p>
      ) : !hasEmail ? (
        <p className="mt-2 text-sm text-muted">This card has no email to reply to.</p>
      ) : (
        <details className="mt-3 rounded-2xl border border-line bg-surface p-4" open={drafts.length === 0}>
          <summary className="cursor-pointer text-sm font-semibold">Draft a reply with Claude</summary>
          <ActionForm id={oppId} action="draft" className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted">
              The reply should
              <select name="mode" defaultValue="express_interest" className={INPUT}>
                {DRAFT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted">
              Tone
              <select name="tone" defaultValue="professional" className={INPUT}>
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted sm:col-span-2">
              Anything to include (optional)
              <textarea
                name="instructions"
                rows={3}
                maxLength={1000}
                placeholder="e.g. “Her fee for 1 reel + 2 stories is ₹1.2 lakh. She's free 3–5 Nov. Ask about usage period.”"
                className={INPUT}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <button className={BUTTON}>Write draft</button>
              <span className="text-xs text-muted">Takes about 10–20 seconds. Facts it doesn't have become [gaps] for you to fill.</span>
            </div>
          </ActionForm>
        </details>
      )}

      <div className="mt-4 space-y-4">
        {drafts.map((d) => (
          <Draft key={d.id} oppId={oppId} d={d} canWrite={canWrite} inboxEmail={inboxEmail} />
        ))}
      </div>
    </section>
  );
}

function Draft({ oppId, d, canWrite, inboxEmail }: { oppId: string; d: DraftView; canWrite: boolean; inboxEmail: string | null }) {
  const gaps = placeholdersIn(d.body ?? "");
  const warnings = d.warnings.filter((w) => w.kind !== "placeholder");
  const head = `${MODE_LABEL[d.mode]} · ${TONE_LABEL[d.tone]} · ${d.created_by_name ?? "Her team"}, ${WHEN.format(d.created_at)}`;

  if (d.status === "generating" || d.status === "failed") {
    return (
      <article id={`draft-${d.id}`} className="scroll-mt-8 rounded-2xl border border-line bg-surface p-4 text-sm">
        <p className="text-muted">{head}</p>
        <p className={`mt-2 ${d.status === "failed" ? "text-alert" : ""}`}>
          {d.status === "generating" ? "Being written… reload in a few seconds." : (d.error ?? "This draft couldn't be written.")}
        </p>
        <ActionForm id={oppId} action="draft_discard" className="mt-2">
          <input type="hidden" name="draft" value={d.id} />
          <button className="text-sm text-muted underline underline-offset-4 hover:text-ink">Remove</button>
        </ActionForm>
      </article>
    );
  }

  if (d.status === "sent" || d.status === "saved_to_gmail") {
    return (
      <article id={`draft-${d.id}`} className="scroll-mt-8 rounded-2xl border border-ok/40 bg-ok/5 p-4 text-sm">
        <p className="font-semibold">
          {d.status === "sent"
            ? `Sent to ${d.to_email}${d.sent_at ? `, ${WHEN.format(d.sent_at)}` : ""}${d.approved_by_email ? ` by ${d.approved_by_email}` : ""}`
            : `Saved in Gmail's drafts for ${d.to_email}. Send it from Gmail.`}
        </p>
        <p className="mt-1 text-muted">{head}</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-muted">Show the reply</summary>
          <p className="mt-2 font-medium">{d.subject}</p>
          <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{d.body}</p>
        </details>
        {d.status === "saved_to_gmail" && (
          <ActionForm id={oppId} action="draft_discard" className="mt-2">
            <input type="hidden" name="draft" value={d.id} />
            <button className="text-sm text-muted underline underline-offset-4 hover:text-ink">Remove from Spotlight</button>
          </ActionForm>
        )}
      </article>
    );
  }

  return (
    <article id={`draft-${d.id}`} className="scroll-mt-8 rounded-2xl border border-gel/60 bg-surface p-4">
      <p className="text-xs text-muted">{head}</p>
      <p className="mt-1 text-sm">
        <span className="text-muted">To </span>
        <span className="font-medium">{d.to_email}</span>
        {inboxEmail && <span className="text-muted">{` · from ${inboxEmail}`}</span>}
      </p>

      {(gaps.length > 0 || warnings.length > 0 || d.ai_notes) && (
        <ul className="mt-3 space-y-1 rounded-xl bg-paper px-4 py-3 text-sm">
          {gaps.map((g) => (
            <li key={g} className="text-alert">{`Fill in ${g} before this can go out.`}</li>
          ))}
          {warnings.map((w, i) => (
            <li key={i} className="text-alert">
              {w.text}
            </li>
          ))}
          {d.ai_notes && <li className="text-muted">{`Note from the draft: ${d.ai_notes}`}</li>}
        </ul>
      )}

      <ActionForm id={oppId} action="draft_save" className="mt-3 space-y-2">
        <input type="hidden" name="draft" value={d.id} />
        <label className="grid gap-1 text-xs text-muted">
          Subject
          <input name="subject" defaultValue={d.subject ?? ""} maxLength={300} className={INPUT} required />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Reply
          <textarea name="body" defaultValue={d.body ?? ""} rows={12} className={`${INPUT} font-[inherit] leading-relaxed`} required />
        </label>
        <button className={BUTTON_QUIET}>Save changes</button>
      </ActionForm>

      <div className="mt-4 border-t border-line pt-4">
        {!canWrite ? (
          <p className="text-sm text-muted">
            Copy the reply into Gmail, or let Spotlight save and send it:{" "}
            <Link href="/settings#gmail" className="underline decoration-gel decoration-2 underline-offset-4">
              allow replies in Settings
            </Link>
            .
          </p>
        ) : gaps.length > 0 ? (
          <p className="text-sm text-muted">Fill in the [gaps] and save, then you can send it or put it in Gmail.</p>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            <ActionForm id={oppId} action="draft_gmail">
              <input type="hidden" name="draft" value={d.id} />
              <button className={BUTTON_QUIET}>Save to Gmail drafts</button>
            </ActionForm>
            <details className="min-w-0 flex-1">
              <summary className="inline-block cursor-pointer rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft">Send…</summary>
              <ActionForm id={oppId} action="draft_send" className="mt-3 space-y-3 rounded-xl border border-line bg-paper p-4 text-sm">
                <input type="hidden" name="draft" value={d.id} />
                <p>{`Sends “${d.subject}” to ${d.to_email} from ${inboxEmail ?? "her Gmail"}, in the same conversation. Save any changes first: the saved version is what goes out.`}</p>
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
                  <span>I've read this reply and want to send it now.</span>
                </label>
                <button className={BUTTON}>Send now</button>
              </ActionForm>
            </details>
          </div>
        )}
        <ActionForm id={oppId} action="draft_discard" className="mt-3">
          <input type="hidden" name="draft" value={d.id} />
          <button className="text-sm text-muted underline underline-offset-4 hover:text-ink">Discard this draft</button>
        </ActionForm>
      </div>
    </article>
  );
}
