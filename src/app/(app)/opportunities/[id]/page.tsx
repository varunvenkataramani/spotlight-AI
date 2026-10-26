import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, BUTTON, BUTTON_QUIET, EmailCard, FieldRow, Flash, INPUT, Timeline } from "@/components/detail";
import { dayValueIST, STATUS_LABEL, STATUSES } from "@/lib/edits.ts";
import { formatDay, payText, relativeDay } from "@/lib/format.ts";
import { getDetail, type Detail, type FieldSource, type ReminderRow } from "@/server/opportunity-detail.ts";
import { markOpened } from "@/server/actions.ts";
import { isUuid } from "@/server/request-guard.ts";
import { requireAdmin, type AdminSession } from "@/server/session.ts";

export const metadata: Metadata = { title: "Opportunity" };

const PRIORITY = {
  high: { label: "High priority", className: "bg-gel text-ink" },
  needs_review: { label: "Check this", className: "border border-alert/60 text-alert" },
  medium: { label: "Medium", className: "border border-ink/25" },
  low: { label: "Low", className: "border border-line text-muted" },
} as const;

const COMP_TYPES = [
  ["paid", "Paid"],
  ["barter", "Barter (products)"],
  ["unpaid", "Unpaid"],
  ["commission", "Commission"],
  ["affiliate", "Affiliate"],
  ["unspecified", "Not stated"],
] as const;

export default async function OpportunityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string; error?: string }>;
}) {
  const { id } = await params;
  const { done, error } = await searchParams;
  if (!isUuid(id)) notFound();
  const me = await requireAdmin();
  const data = await getDetail(id);
  if (!data) notFound();
  const { opportunity: o, sources, emails, timeline, categories, reminders, talentEmail } = data;
  if (!o.is_read) await markOpened(id);

  const src = (name: string): FieldSource | undefined => sources.findLast((s) => s.field_name === name);
  const firstSrc = (...names: string[]) => names.map(src).find(Boolean);
  const unverified = (key: string) => o.unverified_fields.includes(key);
  const quotesFor = (emailId: string) =>
    sources.filter((s) => s.email_id === emailId && s.is_verified && s.source_quote).map((s) => s.source_quote!);
  const p = PRIORITY[o.priority];
  const who = [o.organization, o.sender_name && o.sender_name !== o.organization ? o.sender_name : null, o.sender_email]
    .filter(Boolean)
    .join(" · ");
  const snoozed = o.snoozed_until && o.snoozed_until.getTime() > Date.now();
  const back = `/opportunities/${id}`;

  const textEdit = (field: string, current: string | null, multiline = false) => (
    <ActionForm id={id} action="correct" className="space-y-2">
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="back" value={back} />
      {multiline ? (
        <textarea name="value" defaultValue={current ?? ""} rows={3} className={INPUT} aria-label="New value" />
      ) : (
        <input name="value" defaultValue={current ?? ""} className={INPUT} aria-label="New value" />
      )}
      <p className="text-xs text-muted">Leave empty if the email doesn't say.</p>
      <button className={BUTTON}>Save</button>
    </ActionForm>
  );

  return (
    <>
      <Link href="/opportunities" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
        ← All opportunities
      </Link>

      <header className="mb-8 mt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2.5 py-1 font-semibold ${p.className}`}>{p.label}</span>
          <span className="rounded-full border border-line px-2.5 py-1">{STATUS_LABEL[o.status as keyof typeof STATUS_LABEL] ?? o.status}</span>
          {o.category_name && <span className="text-muted">{o.category_name}</span>}
          {o.from_historical && <span className="rounded-full border border-line px-2 py-0.5 text-muted">Earlier mail</span>}
        </div>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-tight text-balance md:text-4xl">{o.title}</h1>
        {who && <p className="mt-1 break-words text-muted">{who}</p>}
        {o.summary && <p className="mt-4 max-w-3xl text-lg leading-relaxed">{o.summary}</p>}
      </header>

      <Flash done={done} error={error} />

      <div className="mb-8 space-y-3">
        {o.is_irrelevant && (
          <Banner tone="quiet" text="Marked not relevant. It's hidden from the lists.">
            <ActionForm id={id} action="review">
              <input type="hidden" name="decision" value="restore" />
              <button className={BUTTON_QUIET}>Put it back</button>
            </ActionForm>
          </Banner>
        )}
        {o.priority === "needs_review" && !o.is_irrelevant && (
          <Banner tone="alert" text="Check this before replying. The reasons are listed under “Why this priority”.">
            <ActionForm id={id} action="review">
              <input type="hidden" name="decision" value="genuine" />
              <button className={BUTTON}>Checked: it's genuine</button>
            </ActionForm>
            <ActionForm id={id} action="review">
              <input type="hidden" name="decision" value="not_relevant" />
              <input type="hidden" name="back" value="/review" />
              <button className={BUTTON_QUIET}>Not relevant</button>
            </ActionForm>
          </Banner>
        )}
        {o.possible_duplicate_of && (
          <Banner
            tone="quiet"
            text={
              <>
                This might be the same offer as{" "}
                <Link className="underline decoration-gel decoration-2 underline-offset-4" href={`/opportunities/${o.possible_duplicate_of}`}>
                  “{o.duplicate_title}”
                </Link>
                .
              </>
            }
          >
            <ActionForm id={id} action="duplicate">
              <input type="hidden" name="decision" value="merge" />
              <button className={BUTTON}>Merge into that card</button>
            </ActionForm>
            <ActionForm id={id} action="duplicate">
              <input type="hidden" name="decision" value="dismiss" />
              <button className={BUTTON_QUIET}>Keep separate</button>
            </ActionForm>
          </Banner>
        )}
        {snoozed && (
          <Banner tone="quiet" text={`Snoozed until ${formatDay(o.snoozed_until, true)}. It's hidden from the overview until then.`}>
            <ActionForm id={id} action="snooze">
              <input type="hidden" name="days" value="clear" />
              <button className={BUTTON_QUIET}>Unsnooze</button>
            </ActionForm>
          </Banner>
        )}
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="min-w-0 space-y-10">
          <section aria-labelledby="h-status">
            <h2 id="h-status" className="font-display text-xl font-semibold">Status</h2>
            <ActionForm id={id} action="status" className="mt-3 flex flex-wrap items-center gap-2">
              <label htmlFor="status" className="sr-only">Status</label>
              <select id="status" name="status" defaultValue={o.status} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <button className={BUTTON}>Update status</button>
            </ActionForm>
            {!snoozed && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Snooze for</span>
                {[1, 3, 7].map((d) => (
                  <ActionForm key={d} id={id} action="snooze">
                    <input type="hidden" name="days" value={d} />
                    <button className={BUTTON_QUIET}>{d === 1 ? "1 day" : `${d} days`}</button>
                  </ActionForm>
                ))}
              </div>
            )}
          </section>

          <HerCall o={o} me={me} talentEmail={talentEmail} back={back} />

          <Reminders id={id} reminders={reminders} me={me} back={back} />

          <section aria-labelledby="h-why">
            <h2 id="h-why" className="font-display text-xl font-semibold">Why this priority</h2>
            {o.priority_reasons.length > 0 ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                {o.priority_reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted">No particular reasons yet. Add pay and dates to score it.</p>
            )}
            {o.red_flags.length > 0 && (
              <>
                <h3 className="mt-5 text-sm font-semibold">Warning signs</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {o.red_flags.map((f) => (
                    <li key={f.flag} className={f.severity === "high" ? "text-alert" : "text-muted"}>
                      <span aria-hidden="true">{f.severity === "high" ? "▲ " : "△ "}</span>
                      {f.flag}
                      {f.evidence && <span className="block pl-4 text-xs text-muted">“{f.evidence}”</span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">These are signs to check, not a verdict.</p>
              </>
            )}
          </section>

          <section aria-labelledby="h-details">
            <h2 id="h-details" className="font-display text-xl font-semibold">Details</h2>
            <p className="mt-1 text-sm text-muted">Each detail shows the email words it came from. Edit anything that's wrong; priority updates on save.</p>
            <dl className="mt-3 divide-y divide-line">
              <FieldRow label="Title" value={o.title}>
                {textEdit("title", o.title)}
              </FieldRow>
              <FieldRow label="Category" value={o.category_name}>
                <ActionForm id={id} action="correct" className="flex flex-wrap gap-2">
                  <input type="hidden" name="field" value="category" />
                  <select name="value" defaultValue={o.category_slug ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" aria-label="Category">
                    {categories.map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button className={BUTTON}>Save</button>
                </ActionForm>
              </FieldRow>
              <FieldRow label="Company" value={o.organization} source={src("organization")} unverified={unverified("organization")}>
                {textEdit("organization", o.organization)}
              </FieldRow>
              <FieldRow
                label="Pay"
                value={
                  <>
                    <span className="font-semibold tabular-nums">{payText(o)}</span>
                    {o.payment_terms && <span className="text-muted"> · {o.payment_terms}</span>}
                    {o.is_negotiable === true && <span className="text-muted"> · negotiable</span>}
                  </>
                }
                source={src("compensation")}
                unverified={unverified("compensation")}
              >
                <ActionForm id={id} action="correct" className="grid gap-2 sm:grid-cols-2">
                  <input type="hidden" name="field" value="pay" />
                  <label className="grid gap-1 text-xs text-muted sm:col-span-2">
                    How she's paid
                    <select name="type" defaultValue={o.compensation_type} className={INPUT}>
                      {COMP_TYPES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs text-muted">
                    Amount (or lowest)
                    <input name="amount_min" defaultValue={o.amount_min ? String(Number(o.amount_min)) : ""} placeholder="e.g. 75,000 or 1.5 lakh" className={INPUT} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted">
                    Highest, if a range
                    <input name="amount_max" defaultValue={o.amount_max && o.amount_max !== o.amount_min ? String(Number(o.amount_max)) : ""} className={INPUT} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted">
                    Currency
                    <input name="currency" defaultValue={o.currency} className={INPUT} />
                  </label>
                  <div className="flex items-end">
                    <button className={BUTTON}>Save</button>
                  </div>
                </ActionForm>
              </FieldRow>
              <FieldRow
                label="Deliverables"
                value={o.deliverables.length ? o.deliverables.map((d) => d.item).join(", ") : null}
                source={src("deliverables")}
                unverified={unverified("deliverables")}
              >
                <ActionForm id={id} action="correct" className="space-y-2">
                  <input type="hidden" name="field" value="deliverables" />
                  <textarea name="value" rows={4} defaultValue={o.deliverables.map((d) => d.item).join("\n")} className={INPUT} aria-label="Deliverables, one per line" />
                  <p className="text-xs text-muted">One per line, like “1 Instagram reel”.</p>
                  <button className={BUTTON}>Save</button>
                </ActionForm>
              </FieldRow>
              <FieldRow
                label="Reply by"
                value={o.reply_by_at ? `${formatDay(o.reply_by_at, true)} (${relativeDay(o.reply_by_at)})` : null}
                source={firstSrc("date:reply_by", "date:deadline")}
                unverified={unverified("dates") && !firstSrc("date:reply_by", "date:deadline")?.corrected_by_name}
              >
                <ActionForm id={id} action="correct" className="flex flex-wrap gap-2">
                  <input type="hidden" name="field" value="reply_by" />
                  <input type="date" name="value" defaultValue={dayValueIST(o.reply_by_at)} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" aria-label="Reply by" />
                  <button className={BUTTON}>Save</button>
                </ActionForm>
              </FieldRow>
              <FieldRow
                label="Shoot or event"
                value={
                  o.event_start_at
                    ? `${formatDay(o.event_start_at, true)}${o.event_end_at ? ` to ${formatDay(o.event_end_at, true)}` : ""} (${relativeDay(o.event_start_at)})`
                    : null
                }
                source={firstSrc("date:event_start", "date:shoot", "date:audition")}
              >
                <ActionForm id={id} action="correct" className="flex flex-wrap gap-2">
                  <input type="hidden" name="field" value="event_start" />
                  <input type="date" name="value" defaultValue={dayValueIST(o.event_start_at)} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" aria-label="Shoot or event date" />
                  <button className={BUTTON}>Save</button>
                </ActionForm>
              </FieldRow>
              <FieldRow label="Location" value={o.location} source={src("location")} unverified={unverified("location")}>
                {textEdit("location", o.location)}
              </FieldRow>
              <FieldRow label="Usage rights" value={o.usage_rights} source={src("usage_rights")} unverified={unverified("usage_rights")}>
                {textEdit("usage_rights", o.usage_rights, true)}
              </FieldRow>
              <FieldRow label="Exclusivity" value={o.exclusivity} source={src("exclusivity")} unverified={unverified("exclusivity")}>
                {textEdit("exclusivity", o.exclusivity, true)}
              </FieldRow>
              <FieldRow label="Expenses covered" value={o.expenses_covered} source={src("expenses_covered")} unverified={unverified("expenses_covered")}>
                {textEdit("expenses_covered", o.expenses_covered)}
              </FieldRow>
              <FieldRow label="Their next step" value={o.requested_action} source={src("requested_action")} unverified={unverified("requested_action")}>
                {textEdit("requested_action", o.requested_action)}
              </FieldRow>
              <FieldRow label="Sender's role" value={o.sender_role} source={src("sender_role")} unverified={unverified("sender_role")}>
                {textEdit("sender_role", o.sender_role)}
              </FieldRow>
              <FieldRow label="Phone" value={o.contact_phone} source={src("contact_phone")} unverified={unverified("contact_phone")}>
                {textEdit("contact_phone", o.contact_phone)}
              </FieldRow>
            </dl>
            {o.missing_information.length > 0 && (
              <p className="mt-4 rounded-xl bg-paper px-4 py-3 text-sm">
                <span className="font-medium">The email doesn't say: </span>
                {o.missing_information.join(", ")}.
              </p>
            )}
          </section>

          <section aria-labelledby="h-notes">
            <h2 id="h-notes" className="font-display text-xl font-semibold">Notes and history</h2>
            <ActionForm id={id} action="note" className="mt-3 space-y-2">
              <label htmlFor="note" className="sr-only">Add a note</label>
              <textarea id="note" name="text" rows={3} placeholder="Add a note for both of you, e.g. “Called Priya, brief coming Friday”." className={INPUT} required />
              <button className={BUTTON}>Add note</button>
            </ActionForm>
            <div className="mt-6">
              <Timeline items={timeline} />
            </div>
          </section>
        </div>

        <section aria-labelledby="h-emails" className="min-w-0">
          <h2 id="h-emails" className="font-display text-xl font-semibold">
            {emails.length === 1 ? "The email" : `The emails (${emails.length})`}
          </h2>
          <p className="mt-1 text-sm text-muted">Highlighted words are where the details came from.</p>
          <div className="mt-4 space-y-4">
            {emails.length === 0 ? (
              <p className="text-sm text-muted">No emails are linked to this card.</p>
            ) : (
              emails.map((e) => <EmailCard key={e.id} email={e} quotes={quotesFor(e.id)} />)
            )}
          </div>
        </section>
      </div>
    </>
  );
}

const ANSWER_LABEL = { interested: "Interested", pass: "Pass", questions: "Has questions" } as const;
const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** Putting the offer to her, and her answer. */
function HerCall({ o, me, talentEmail, back }: { o: Detail; me: AdminSession; talentEmail: string | null; back: string }) {
  const isHer = talentEmail === me.email;
  const waiting = o.flagged_for_talent_at && !o.talent_response;
  return (
    <section aria-labelledby="h-her" className="rounded-2xl border border-line bg-surface p-5">
      <h2 id="h-her" className="font-display text-xl font-semibold">{isHer ? "Your call" : "Her call"}</h2>

      {!talentEmail ? (
        <p className="mt-2 text-sm text-muted">
          To send offers to her with Interested, Pass and Questions buttons, choose which admin is the actress in{" "}
          <Link href="/settings" className="underline decoration-gel decoration-2 underline-offset-4">Settings</Link>.
        </p>
      ) : !o.flagged_for_talent_at ? (
        isHer ? (
          <p className="mt-2 text-sm text-muted">Not sent to you yet. You can still set the status above.</p>
        ) : (
          <ActionForm id={o.id} action="flag" className="mt-3 space-y-2">
            <input type="hidden" name="back" value={back} />
            <label htmlFor="flag-note" className="text-sm text-muted">
              Sends it to her in Telegram, on her phone and in Spotlight. Add a line for her if you like:
            </label>
            <textarea id="flag-note" name="note" rows={2} maxLength={300} placeholder="e.g. “Good brand, and the fee is fair.”" className={INPUT} />
            <button className={BUTTON}>Flag for her</button>
          </ActionForm>
        )
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          <p className="text-muted">
            {isHer ? "Sent to you" : "Sent to her"} {WHEN.format(o.flagged_for_talent_at)}
            {o.flagged_by_name ? ` by ${o.flagged_by_name}` : ""}.
          </p>
          {o.talent_response && o.talent_responded_at && (
            <p className="rounded-xl bg-paper px-4 py-3">
              <span className="font-semibold">{`${isHer ? "You said" : "She said"}: ${ANSWER_LABEL[o.talent_response]}`}</span>
              <span className="text-muted">{` · ${WHEN.format(o.talent_responded_at)}`}</span>
              {o.talent_response_note && <span className="mt-1 block whitespace-pre-wrap">“{o.talent_response_note}”</span>}
            </p>
          )}
          {(waiting || isHer) && (
            <ActionForm id={o.id} action="answer" className="space-y-2">
              <input type="hidden" name="back" value={back} />
              <p className="font-medium">{isHer ? (waiting ? "Are you interested?" : "Change your answer") : "Answer for her (if she told you directly)"}</p>
              <textarea name="note" rows={2} maxLength={1000} placeholder={isHer ? "Questions or a note for your team (optional)" : "What she said (optional)"} className={INPUT} />
              <div className="flex flex-wrap gap-2">
                <button name="answer" value="interested" className={BUTTON}>Interested</button>
                <button name="answer" value="pass" className={BUTTON_QUIET}>Pass</button>
                <button name="answer" value="questions" className={BUTTON_QUIET}>Questions</button>
              </div>
            </ActionForm>
          )}
          {!isHer && (
            <div className="flex flex-wrap gap-2">
              {o.talent_response && (
                <ActionForm id={o.id} action="flag">
                  <input type="hidden" name="back" value={back} />
                  <button className={BUTTON_QUIET}>Ask her again</button>
                </ActionForm>
              )}
              <ActionForm id={o.id} action="unflag">
                <input type="hidden" name="back" value={back} />
                <button className={BUTTON_QUIET}>{waiting ? "Withdraw" : "Clear her answer"}</button>
              </ActionForm>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Reminders({ id, reminders, me, back }: { id: string; reminders: ReminderRow[]; me: AdminSession; back: string }) {
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  return (
    <section aria-labelledby="h-remind">
      <h2 id="h-remind" className="font-display text-xl font-semibold">Reminders</h2>
      {reminders.length > 0 ? (
        <ul className="mt-3 divide-y divide-line text-sm">
          {reminders.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium tabular-nums">{WHEN.format(r.due_at)}</span>
                <span className="text-muted"> · {r.for_user === null ? "for both of you" : r.for_user === me.userId ? "for you" : `for ${r.created_by_name ?? "the other admin"}`}</span>
                {r.note && <span className="block break-words">{r.note}</span>}
              </span>
              <ActionForm id={id} action="cancel_reminder">
                <input type="hidden" name="reminder" value={r.id} />
                <input type="hidden" name="back" value={back} />
                <button className="text-sm text-muted underline underline-offset-4 hover:text-ink">Cancel</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">Set one to get an alert at a time you choose, for example to follow up or to check a contract.</p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Add a reminder</summary>
        <ActionForm id={id} action="remind" className="mt-3 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="back" value={back} />
          <label className="grid gap-1 text-xs text-muted">
            Day
            <input type="date" name="day" defaultValue={dayValueIST(tomorrow)} className={INPUT} required />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            Time (India)
            <input type="time" name="time" defaultValue="10:00" className={INPUT} required />
          </label>
          <label className="grid gap-1 text-xs text-muted sm:col-span-2">
            What about (optional)
            <input name="note" maxLength={120} placeholder="e.g. Follow up on the contract" className={INPUT} />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            For
            <select name="who" defaultValue="me" className={INPUT}>
              <option value="me">Just me</option>
              <option value="both">Both of us</option>
            </select>
          </label>
          <div className="flex items-end">
            <button className={BUTTON}>Set reminder</button>
          </div>
        </ActionForm>
      </details>
    </section>
  );
}

function Banner({ tone, text, children }: { tone: "alert" | "quiet"; text: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-4 ${
        tone === "alert" ? "border border-alert/40 bg-alert/5" : "border border-line bg-surface"
      }`}
    >
      <p className="min-w-0 max-w-2xl text-sm leading-relaxed">{text}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
