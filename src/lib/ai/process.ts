// Sorts stored emails into opportunities. Runs in the scheduled job after Gmail sync.
// For each waiting email: triage (quick model) → for real offers, extraction (stronger model)
// → checks in code (quotes, dates, red flags, priority) → create or update an opportunity.
// Each email's writes happen in one transaction, and nothing is ever sent or agreed to.
import type pg from "pg";
import { getPool, query } from "../db.ts";
import { callJson, ClaudeApiError } from "./anthropic.ts";
import {
  extractionSystemPrompt,
  EXTRACT_BODY_CHARS,
  TRIAGE_BODY_CHARS,
  triageSystemPrompt,
  userMessage,
  type CategoryInfo,
  type EmailForAi,
} from "./prompts.ts";
import { computePriority, EMPTY_PREFERENCES, formatMoney, type Preferences } from "./priority.ts";
import { mergeRedFlags, ruleRedFlags, type RedFlag } from "./redflags.ts";
import {
  extractionSchema,
  InvalidAnswerError,
  OPPORTUNITY_CLASSES,
  triageSchema,
  validateExtraction,
  validateTriage,
  type Classification,
  type TriageAnswer,
} from "./schemas.ts";
import { normalizeForMatch, TEXT_FIELDS, verifyExtraction, type VerifiedExtraction } from "./verify.ts";

export const MAX_AI_ATTEMPTS = 3;
const BATCH = 16;
const CONCURRENCY = 2; // stays below the connection pool size (the scheduler holds one connection for its lock)
const CONFIDENT = 0.7;
const OPEN = `('new','reviewed','interested','needs_information','reply_drafted','awaiting_my_response','awaiting_their_response','in_negotiation','confirmed','accepted')`;

export type AiDeps = {
  apiKey: string;
  baseUrl: string;
  triageModel: string;
  extractModel: string;
  /** Epoch ms by which this run must stop starting new work. */
  deadline: number;
  fetchImpl?: typeof fetch;
};

export type AiReport = {
  processed: number;
  created: number;
  updated: number;
  needsReview: number;
  retryLater: number;
  accountProblem?: string;
};

/** Claude rejected the API key or the account has no credit: stop until an admin fixes it. */
export class AiAccountError extends Error {}
/** Not enough time left in this run; the email goes back to waiting without using up an attempt. */
class Deferred extends Error {}

type EmailRow = {
  id: string;
  gmail_account_id: string;
  gmail_thread_id: string;
  in_reply_to: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  to_emails: string[];
  subject: string | null;
  body_text: string | null;
  received_at: Date;
  gmail_labels: string[];
  attachment_names: string[];
  is_historical: boolean;
  processing_attempts: number;
  classification: Classification | null;
  classification_confidence: string | null;
  classification_reason: string | null;
  triage_category: string | null;
};

type Context = {
  deps: AiDeps;
  categories: Array<CategoryInfo & { id: string }>;
  slugs: string[];
  prefs: Preferences;
  report: AiReport;
};

// --- Entry point --------------------------------------------------------------------------------

export async function processPendingEmails(deps: AiDeps): Promise<AiReport> {
  const report: AiReport = { processed: 0, created: 0, updated: 0, needsReview: 0, retryLater: 0 };
  if (deps.deadline - Date.now() < 12_000) return report;

  const categories = await query<CategoryInfo & { id: string }>(
    `SELECT id, slug, name, description FROM categories WHERE is_enabled ORDER BY sort_order, name`,
  );
  const ctx: Context = { deps, categories, slugs: categories.map((c) => c.slug), prefs: await loadPreferences(), report };

  const batch = await query<EmailRow>(
    `SELECT id, gmail_account_id, gmail_thread_id, in_reply_to, from_name, from_email, reply_to, to_emails, subject,
            body_text, received_at, gmail_labels, attachment_names, is_historical, processing_attempts,
            classification, classification_confidence, classification_reason, triage_category
     FROM emails
     WHERE processing_state IN ('pending', 'failed') AND processing_attempts < $1
       AND (processing_not_before IS NULL OR processing_not_before <= now())
     ORDER BY is_historical ASC, received_at ASC
     LIMIT $2`,
    [MAX_AI_ATTEMPTS, BATCH],
  );

  // Emails in one conversation are handled in order, so a reply always finds the offer it belongs to.
  const threads = new Map<string, EmailRow[]>();
  for (const e of batch) {
    const key = `${e.gmail_account_id}:${e.gmail_thread_id}`;
    threads.set(key, [...(threads.get(key) ?? []), e]);
  }

  let accountError: AiAccountError | null = null;
  await runWithConcurrency([...threads.values()], CONCURRENCY, async (thread) => {
    for (const email of thread) {
      if (accountError) return;
      try {
        await processOne(email, ctx);
      } catch (error) {
        if (error instanceof AiAccountError) accountError = error;
        else throw error;
      }
    }
  });
  if (accountError) report.accountProblem = (accountError as AiAccountError).message;
  return report;
}

// --- One email ----------------------------------------------------------------------------------

async function processOne(email: EmailRow, ctx: Context): Promise<void> {
  if (ctx.deps.deadline - Date.now() < 12_000) return;
  await query(
    `UPDATE emails SET processing_state = 'processing', processing_attempts = processing_attempts + 1 WHERE id = $1`,
    [email.id],
  );
  const attempt = email.processing_attempts + 1;

  try {
    const triage = await getTriage(email, ctx);
    const linked = await findLinkedOpportunity(email);

    if (triage.confidence < CONFIDENT || triage.classification === "unclear") {
      if (linked) return await attachWithoutDetails(email, linked, ctx);
      return await markEmail(email.id, "needs_review", null, ctx);
    }
    if (!OPPORTUNITY_CLASSES.has(triage.classification)) {
      if (linked) return await attachWithoutDetails(email, linked, ctx);
      return await markEmail(email.id, "processed", null, ctx);
    }

    if (ctx.deps.deadline - Date.now() < 8_000) throw new Deferred();
    const raw = await callChecked("extract", email, ctx, (data) => validateExtraction(data, ctx.slugs));
    const verified = verifyExtraction(raw, {
      fromName: email.from_name,
      fromEmail: email.from_email,
      subject: email.subject,
      bodyText: email.body_text ?? "",
    });
    const flags = mergeRedFlags(
      ruleRedFlags({
        fromEmail: email.from_email,
        fromName: email.from_name,
        replyTo: email.reply_to,
        subject: email.subject,
        body: email.body_text ?? "",
        organization: verified.text.organization.value || null,
      }),
      verified.aiRedFlags,
    );

    let target = linked;
    let linkedBy: "thread" | "ai_match" = "thread";
    if (!target && (triage.classification === "opportunity_update" || triage.classification === "negotiation_or_contract")) {
      const candidates = await openOpportunitiesFromSender(email);
      if (candidates.length !== 1) {
        return await markEmail(
          email.id,
          "needs_review",
          candidates.length === 0
            ? "Looks like an update to an earlier offer, but no matching offer was found."
            : "Looks like an update, but this sender has several open offers. Choose the right one.",
          ctx,
        );
      }
      target = candidates[0]!.id;
      linkedBy = "ai_match";
    }

    await inTransaction(async (client) => {
      if (target) await updateOpportunity(client, target, email, triage, verified, flags, linkedBy, ctx);
      else await createOpportunity(client, email, triage, verified, flags, ctx);
      await client.query(
        `UPDATE emails SET processing_state = 'processed', processed_at = now(), processing_error = NULL WHERE id = $1`,
        [email.id],
      );
    });
    ctx.report.processed++;
  } catch (error) {
    await handleFailure(email, attempt, error, ctx);
  }
}

async function handleFailure(email: EmailRow, attempt: number, error: unknown, ctx: Context) {
  if (error instanceof Deferred) {
    await query(`UPDATE emails SET processing_state = 'pending', processing_attempts = processing_attempts - 1 WHERE id = $1`, [email.id]);
    return;
  }
  if (error instanceof ClaudeApiError && error.isAccountProblem) {
    await query(`UPDATE emails SET processing_state = 'pending', processing_attempts = processing_attempts - 1 WHERE id = $1`, [email.id]);
    throw new AiAccountError(
      error.status === 401
        ? "Claude rejected the API key. Check ANTHROPIC_API_KEY in Vercel."
        : "Claude refused the request for this account (check credit and billing at console.anthropic.com).",
    );
  }
  if (error instanceof InvalidAnswerError) {
    return markEmail(email.id, "needs_review", "The AI's answer couldn't be read twice in a row. Sort this one by hand.", ctx);
  }
  const transient = !(error instanceof ClaudeApiError) || error.isTransient;
  const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
  if (transient && attempt < MAX_AI_ATTEMPTS) {
    ctx.report.retryLater++;
    await query(
      `UPDATE emails SET processing_state = 'failed', processing_error = $2,
              processing_not_before = now() + make_interval(mins => $3)
       WHERE id = $1`,
      [email.id, message, 2 ** attempt],
    );
    return;
  }
  return markEmail(email.id, "needs_review", `Couldn't be sorted automatically: ${message}`, ctx);
}

async function markEmail(emailId: string, state: "processed" | "needs_review", note: string | null, ctx: Context) {
  await query(
    `UPDATE emails SET processing_state = $2, processed_at = now(), processing_error = $3 WHERE id = $1`,
    [emailId, state, note],
  );
  ctx.report.processed++;
  if (state === "needs_review") ctx.report.needsReview++;
}

// --- Claude calls --------------------------------------------------------------------------------

function toAiEmail(email: EmailRow): EmailForAi {
  return {
    fromName: email.from_name,
    fromEmail: email.from_email,
    replyTo: email.reply_to,
    to: email.to_emails,
    subject: email.subject,
    receivedAt: email.received_at,
    labels: email.gmail_labels,
    attachmentNames: email.attachment_names,
    bodyText: email.body_text ?? "",
  };
}

async function getTriage(email: EmailRow, ctx: Context): Promise<TriageAnswer> {
  // A retried email keeps the triage it already paid for.
  if (email.classification && email.classification_confidence !== null) {
    return {
      classification: email.classification,
      confidence: Number(email.classification_confidence),
      category: email.triage_category ?? "none",
      reason: email.classification_reason ?? "",
    };
  }
  const triage = await callChecked("triage", email, ctx, (data) => validateTriage(data, ctx.slugs));
  await query(
    `UPDATE emails SET classification = $2, classification_confidence = $3, classification_reason = $4, triage_category = $5 WHERE id = $1`,
    [email.id, triage.classification, triage.confidence.toFixed(3), triage.reason.slice(0, 500), triage.category],
  );
  return triage;
}

/** One call, and one more if the answer is malformed. Usage is recorded either way. */
async function callChecked<T>(step: "triage" | "extract", email: EmailRow, ctx: Context, validate: (data: unknown) => T): Promise<T> {
  const ai = toAiEmail(email);
  const isTriage = step === "triage";
  const model = isTriage ? ctx.deps.triageModel : ctx.deps.extractModel;
  const system = isTriage ? triageSystemPrompt(ctx.categories) : extractionSystemPrompt(ctx.categories, new Date());
  const user = userMessage(
    ai,
    isTriage ? TRIAGE_BODY_CHARS : EXTRACT_BODY_CHARS,
    isTriage ? "Classify this email." : "Extract the opportunity details from this email.",
  );
  const schema = isTriage ? triageSchema(ctx.slugs) : extractionSchema(ctx.slugs);

  let lastProblem: InvalidAnswerError | null = null;
  for (let i = 0; i < 2; i++) {
    const remaining = ctx.deps.deadline - Date.now() + 10_000; // calls may finish just past the soft deadline
    if (remaining < 5_000) throw new Deferred();
    const result = await callJson({
      apiKey: ctx.deps.apiKey,
      baseUrl: ctx.deps.baseUrl,
      model,
      system,
      user,
      schema,
      maxTokens: isTriage ? 400 : 3000,
      timeoutMs: Math.min(40_000, remaining),
      fetchImpl: ctx.deps.fetchImpl,
    });
    try {
      const value = validate(result.data);
      await recordUsage(email.id, step, model, result.inputTokens, result.outputTokens, true);
      return value;
    } catch (error) {
      await recordUsage(email.id, step, model, result.inputTokens, result.outputTokens, false);
      if (!(error instanceof InvalidAnswerError)) throw error;
      lastProblem = error;
    }
  }
  throw lastProblem ?? new InvalidAnswerError(["no answer"]);
}

async function recordUsage(emailId: string, step: string, model: string, input: number, output: number, ok: boolean) {
  await query(`INSERT INTO ai_usage (email_id, step, model, input_tokens, output_tokens, ok) VALUES ($1,$2,$3,$4,$5,$6)`, [
    emailId,
    step,
    model,
    input,
    output,
    ok,
  ]);
}

// --- Matching ------------------------------------------------------------------------------------

async function findLinkedOpportunity(email: EmailRow): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `SELECT o.id FROM opportunity_emails oe
     JOIN emails e ON e.id = oe.email_id
     JOIN opportunities o ON o.id = oe.opportunity_id
     WHERE e.gmail_account_id = $1 AND e.id <> $4
       AND (e.gmail_thread_id = $2 OR ($3::text IS NOT NULL AND e.rfc_message_id = $3::text))
     ORDER BY o.last_activity_at DESC LIMIT 1`,
    [email.gmail_account_id, email.gmail_thread_id, email.in_reply_to, email.id],
  );
  return rows[0]?.id ?? null;
}

type Candidate = { id: string; title: string; organization: string | null };

/** Open offers from the same sender. Inside a transaction, pass its client: never take a second connection while holding one. */
async function openOpportunitiesFromSender(email: EmailRow, client?: pg.PoolClient): Promise<Candidate[]> {
  if (!email.from_email) return [];
  const result = await (client ?? getPool()).query<Candidate>(
    `SELECT id, title, organization FROM opportunities
     WHERE gmail_account_id = $1 AND lower(sender_email) = lower($2) AND status IN ${OPEN}
       AND last_activity_at > now() - interval '120 days'
     ORDER BY last_activity_at DESC LIMIT 5`,
    [email.gmail_account_id, email.from_email],
  );
  return result.rows;
}

function words(s: string): Set<string> {
  return new Set(normalizeForMatch(s).split(/[^a-z0-9ऀ-ॿ]+/).filter((w) => w.length > 2));
}

export function looksLikeSameOffer(a: { title: string; organization: string | null }, b: { title: string; organization: string | null }): boolean {
  const orgA = normalizeForMatch(a.organization ?? "");
  const orgB = normalizeForMatch(b.organization ?? "");
  if (orgA && orgA === orgB) return true;
  const wa = words(a.title);
  const wb = words(b.title);
  if (wa.size === 0 || wb.size === 0) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / new Set([...wa, ...wb]).size >= 0.5;
}

// --- Writing opportunities -------------------------------------------------------------------------

const nul = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

function missingInfo(v: VerifiedExtraction): string[] {
  const list = [...v.missingInformation];
  const c = v.compensation;
  if (c.status === "not_disclosed" && c.type !== "barter" && c.type !== "unpaid") list.push("Fee");
  if (v.dates.length === 0) list.push("Dates");
  const seen = new Set<string>();
  return list.filter((m) => {
    const k = m.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function createOpportunity(
  client: pg.PoolClient,
  email: EmailRow,
  triage: TriageAnswer,
  v: VerifiedExtraction,
  flags: RedFlag[],
  ctx: Context,
) {
  const category = ctx.categories.find((c) => c.slug === v.category) ?? ctx.categories.find((c) => c.slug === triage.category);
  const priority = computePriority(
    {
      classification: triage.classification,
      confidence: triage.confidence,
      categorySlug: category?.slug ?? null,
      organization: nul(v.text.organization.value),
      location: nul(v.text.location.value),
      compensation: v.compensation,
      nextDeadline: v.nextDeadline,
      latestPastDeadline: v.latestPastDeadline,
      redFlags: flags,
      cancelled: v.cancellation,
      unverified: v.unverified,
    },
    ctx.prefs,
  );

  // A possible duplicate is only suggested for an admin to confirm; nothing is merged automatically.
  let duplicateOf: string | null = null;
  for (const c of await openOpportunitiesFromSender(email, client)) {
    if (looksLikeSameOffer({ title: v.title, organization: nul(v.text.organization.value) }, c)) {
      duplicateOf = c.id;
      break;
    }
  }

  const c = v.compensation;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO opportunities (
       gmail_account_id, title, category_id, summary, description, sender_name, sender_email, organization, sender_role,
       contact_phone, compensation_type, compensation_status, amount_min, amount_max, currency, payment_terms, is_negotiable,
       usage_rights, exclusivity, expenses_covered, deliverables, location, format, event_start_at, event_end_at,
       reply_by_at, next_deadline_at, requested_action, missing_information, priority, priority_score, priority_reasons,
       red_flags, confidence, status, first_received_at, last_activity_at, from_historical, unverified_fields,
       classification, possible_duplicate_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
             $29,$30,$31,$32,$33,$34,'new',$35,$35,$36,$37,$38,$39)
     RETURNING id`,
    [
      email.gmail_account_id,
      v.title,
      category?.id ?? null,
      nul(v.summary),
      nul(v.text.offer.value),
      email.from_name,
      email.from_email,
      nul(v.text.organization.value),
      nul(v.text.sender_role.value),
      nul(v.text.contact_phone.value),
      c.type,
      c.status,
      c.amountMin,
      c.amountMax,
      c.currency,
      nul(c.text),
      v.isNegotiable,
      nul(v.text.usage_rights.value),
      nul(v.text.exclusivity.value),
      nul(v.text.expenses_covered.value),
      JSON.stringify(v.deliverables.map((d) => ({ item: d.item, verified: d.verified }))),
      nul(v.text.location.value),
      v.format,
      v.eventStart,
      v.eventEnd,
      v.replyBy,
      v.nextDeadline,
      nul(v.text.requested_action.value),
      JSON.stringify(missingInfo(v)),
      priority.priority,
      priority.score,
      JSON.stringify(priority.reasons),
      JSON.stringify(flags),
      triage.confidence.toFixed(3),
      email.received_at,
      email.is_historical,
      v.unverified,
      triage.classification,
      duplicateOf,
    ],
  );
  const oppId = inserted.rows[0]!.id;

  await client.query(`INSERT INTO opportunity_emails (opportunity_id, email_id, role, linked_by) VALUES ($1, $2, 'original', 'thread')`, [
    oppId,
    email.id,
  ]);
  await saveFields(client, oppId, email.id, v, triage.confidence, null);
  await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'ai', 'created', $2)`, [
    oppId,
    JSON.stringify({ emailId: email.id, classification: triage.classification, reason: triage.reason }),
  ]);
  if (duplicateOf) {
    await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'ai', 'possible_duplicate', $2)`, [
      oppId,
      JSON.stringify({ of: duplicateOf }),
    ]);
  }
  ctx.report.created++;
}

/** Stores each extracted value with its quote. With onlyFields, saves just those (marking older ones superseded). */
async function saveFields(
  client: pg.PoolClient,
  oppId: string,
  emailId: string,
  v: VerifiedExtraction,
  confidence: number,
  onlyFields: Set<string> | null,
) {
  const rows: Array<[string, string | null, unknown, string | null, boolean]> = [];
  for (const f of TEXT_FIELDS) {
    const t = v.text[f];
    if (t.value) rows.push([f, t.value, null, nul(t.quote), t.verified]);
  }
  const c = v.compensation;
  if (c.status !== "not_disclosed" || c.type !== "unspecified") {
    rows.push([
      "compensation",
      c.text || null,
      { type: c.type, status: c.status, amountMin: c.amountMin, amountMax: c.amountMax, currency: c.currency },
      nul(c.quote),
      c.verified,
    ]);
  }
  if (v.deliverables.length > 0) {
    rows.push(["deliverables", v.deliverables.map((d) => d.item).join("; "), v.deliverables, null, v.deliverables.every((d) => d.verified)]);
  }
  for (const d of v.dates) {
    rows.push([`date:${d.kind}`, d.text || null, { at: d.at?.toISOString() ?? null }, nul(d.quote), d.verified]);
  }

  for (const [name, text, json, quote, verified] of rows) {
    const key = name.startsWith("date:") ? "dates" : name;
    if (onlyFields && !onlyFields.has(key)) continue;
    if (onlyFields) {
      await client.query(`UPDATE extracted_fields SET is_current = false WHERE opportunity_id = $1 AND field_name = $2`, [oppId, name]);
    }
    await client.query(
      `INSERT INTO extracted_fields (opportunity_id, email_id, field_name, value_text, value_json, source_quote, is_verified, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [oppId, emailId, name, text, json === null ? null : JSON.stringify(json), quote, verified && quote !== null, confidence.toFixed(3)],
    );
  }
}

type OppRow = {
  id: string;
  status: string;
  classification: Classification | null;
  confidence: string | null;
  category_slug: string | null;
  organization: string | null;
  location: string | null;
  usage_rights: string | null;
  exclusivity: string | null;
  expenses_covered: string | null;
  compensation_type: string;
  compensation_status: string;
  amount_min: string | null;
  amount_max: string | null;
  currency: string;
  deliverables: Array<{ item: string; verified: boolean }>;
  reply_by_at: Date | null;
  event_start_at: Date | null;
  event_end_at: Date | null;
  next_deadline_at: Date | null;
  red_flags: RedFlag[];
  unverified_fields: string[];
};

async function loadOpportunity(client: pg.PoolClient, id: string): Promise<OppRow> {
  const r = await client.query<OppRow>(
    `SELECT o.id, o.status, o.classification, o.confidence, c.slug AS category_slug, o.organization, o.location, o.usage_rights,
            o.exclusivity, o.expenses_covered, o.compensation_type, o.compensation_status, o.amount_min, o.amount_max,
            o.currency, o.deliverables, o.reply_by_at, o.event_start_at, o.event_end_at, o.next_deadline_at, o.red_flags,
            o.unverified_fields
     FROM opportunities o LEFT JOIN categories c ON c.id = o.category_id
     WHERE o.id = $1 FOR UPDATE OF o`,
    [id],
  );
  return r.rows[0]!;
}

/** A thread reply that isn't itself about the offer's details: keep it on the timeline only. */
async function attachWithoutDetails(email: EmailRow, oppId: string, ctx: Context) {
  await inTransaction(async (client) => {
    const opp = await loadOpportunity(client, oppId);
    await client.query(
      `INSERT INTO opportunity_emails (opportunity_id, email_id, role, linked_by) VALUES ($1, $2, 'other', 'thread') ON CONFLICT DO NOTHING`,
      [oppId, email.id],
    );
    await touchOpportunity(client, opp, email);
    await client.query(`UPDATE emails SET processing_state = 'processed', processed_at = now(), processing_error = NULL WHERE id = $1`, [
      email.id,
    ]);
  });
  ctx.report.processed++;
  ctx.report.updated++;
}

/** New mail from them: newest activity, unread, and if we were waiting on them, now it's our turn. */
async function touchOpportunity(client: pg.PoolClient, opp: OppRow, email: EmailRow) {
  await client.query(
    `UPDATE opportunities SET last_activity_at = GREATEST(last_activity_at, $2), is_read = false WHERE id = $1`,
    [opp.id, email.received_at],
  );
  await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'system', 'email_received', $2)`, [
    opp.id,
    JSON.stringify({ emailId: email.id }),
  ]);
  if (!email.is_historical && (opp.status === "awaiting_their_response" || opp.status === "reply_drafted")) {
    await client.query(`UPDATE opportunities SET status = 'awaiting_my_response' WHERE id = $1`, [opp.id]);
    await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'system', 'status_changed', $2)`, [
      opp.id,
      JSON.stringify({ from: opp.status, to: "awaiting_my_response", because: "They replied" }),
    ]);
  }
}

const sameText = (a: string | null, b: string | null) => normalizeForMatch(a ?? "") === normalizeForMatch(b ?? "");
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const money = (min: number | null, max: number | null, cur: string) =>
  min === null ? "not stated" : max !== null && max !== min ? `${formatMoney(min, cur)}–${formatMoney(max, cur)}` : formatMoney(min, cur);
const istDay = (d: Date | null) =>
  d ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(d) : "none";

async function updateOpportunity(
  client: pg.PoolClient,
  oppId: string,
  email: EmailRow,
  triage: TriageAnswer,
  v: VerifiedExtraction,
  newFlags: RedFlag[],
  linkedBy: "thread" | "ai_match",
  ctx: Context,
) {
  const opp = await loadOpportunity(client, oppId);
  const changes: Array<{ field: string; column: string; from: string; to: string; value: unknown; quote: string; verified: boolean }> = [];
  const c = v.compensation;
  const curMin = opp.amount_min === null ? null : Number(opp.amount_min);
  const curMax = opp.amount_max === null ? null : Number(opp.amount_max);

  // Values are only ever added or changed by a follow-up, never cleared because it didn't repeat them.
  if (c.amountMin !== null && (c.amountMin !== curMin || c.amountMax !== curMax || c.currency !== opp.currency)) {
    changes.push({
      field: "compensation",
      column: "amounts",
      from: money(curMin, curMax, opp.currency),
      to: money(c.amountMin, c.amountMax, c.currency),
      value: null,
      quote: c.quote,
      verified: c.verified,
    });
  }
  for (const [column, cur, next] of [
    ["reply_by_at", opp.reply_by_at, v.replyBy],
    ["event_start_at", opp.event_start_at, v.eventStart],
    ["event_end_at", opp.event_end_at, v.eventEnd],
  ] as const) {
    if (next && !sameTime(cur, next)) {
      // Never store an end before its start (the database refuses it); keep the old value instead.
      const start = column === "event_end_at" ? (v.eventStart ?? opp.event_start_at) : null;
      const end = column === "event_start_at" ? (v.eventEnd ?? opp.event_end_at) : null;
      if ((start && next.getTime() < start.getTime()) || (end && next.getTime() > end.getTime())) continue;
      const d = v.dates.find((x) => x.at && x.at.getTime() === next.getTime());
      changes.push({ field: "dates", column, from: istDay(cur), to: istDay(next), value: next, quote: d?.quote ?? "", verified: d?.verified ?? false });
    }
  }
  for (const f of ["location", "usage_rights", "exclusivity", "expenses_covered"] as const) {
    const next = v.text[f];
    if (next.value && !sameText(opp[f], next.value)) {
      changes.push({ field: f, column: f, from: opp[f] ?? "not stated", to: next.value, value: next.value, quote: next.quote, verified: next.verified });
    }
  }
  const curItems = new Set(opp.deliverables.map((d) => normalizeForMatch(d.item)));
  const newItems = new Set(v.deliverables.map((d) => normalizeForMatch(d.item)));
  if (newItems.size > 0 && (newItems.size !== curItems.size || [...newItems].some((i) => !curItems.has(i)))) {
    changes.push({
      field: "deliverables",
      column: "deliverables",
      from: opp.deliverables.map((d) => d.item).join("; ") || "not stated",
      to: v.deliverables.map((d) => d.item).join("; "),
      value: JSON.stringify(v.deliverables.map((d) => ({ item: d.item, verified: d.verified }))),
      quote: v.deliverables.map((d) => d.quote).join(" … "),
      verified: v.deliverables.every((d) => d.verified),
    });
  }

  for (const ch of changes) {
    if (ch.column === "amounts") {
      await client.query(
        `UPDATE opportunities SET amount_min = $2, amount_max = $3, currency = $4, compensation_status = $5,
                compensation_type = CASE WHEN $6 = 'unspecified' THEN compensation_type ELSE $6 END, payment_terms = COALESCE($7, payment_terms)
         WHERE id = $1`,
        [oppId, c.amountMin, c.amountMax, c.currency, c.status, c.type, nul(c.text)],
      );
    } else {
      await client.query(`UPDATE opportunities SET ${ch.column} = $2 WHERE id = $1`, [oppId, ch.value]);
    }
    await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'ai', 'change_detected', $2)`, [
      oppId,
      JSON.stringify({ field: ch.field, from: ch.from, to: ch.to, quote: ch.quote, verified: ch.verified, emailId: email.id }),
    ]);
  }
  if (changes.length === 0 && c.amountMin === null && c.status === "requested_rate" && opp.compensation_status === "not_disclosed") {
    await client.query(`UPDATE opportunities SET compensation_status = 'requested_rate' WHERE id = $1`, [oppId]);
  }
  await saveFields(client, oppId, email.id, v, triage.confidence, new Set(changes.map((ch) => ch.field)));

  if (v.cancellation) {
    await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'ai', 'cancellation_detected', $2)`, [
      oppId,
      JSON.stringify({ emailId: email.id }),
    ]);
  }

  // Red flags accumulate; unverified field names accumulate until an admin corrects them.
  const flags = [...opp.red_flags];
  for (const f of newFlags) if (!flags.some((x) => x.flag === f.flag)) flags.push(f);
  const unverified = [...new Set([...opp.unverified_fields, ...v.unverified.filter((u) => changes.some((ch) => ch.field === u))])];

  // Recompute timing and priority from the record as it now stands.
  const after = await loadOpportunity(client, oppId);
  const now = Date.now();
  const changedDates = changes.some((ch) => ch.field === "dates");
  const candidates = [after.reply_by_at, after.event_start_at, v.nextDeadline, changedDates ? null : opp.next_deadline_at].filter(
    (d): d is Date => d !== null,
  );
  const future = candidates.filter((d) => d.getTime() >= now).sort((a, b) => a.getTime() - b.getTime());
  const past = [after.reply_by_at, after.event_start_at, after.event_end_at, v.latestPastDeadline]
    .filter((d): d is Date => d !== null && d.getTime() < now)
    .sort((a, b) => a.getTime() - b.getTime());
  const cancelled =
    v.cancellation ||
    (await client.query(`SELECT 1 FROM activities WHERE opportunity_id = $1 AND kind = 'cancellation_detected' LIMIT 1`, [oppId])).rowCount! > 0;

  const priority = computePriority(
    {
      classification: opp.classification ?? triage.classification,
      confidence: opp.confidence === null ? triage.confidence : Number(opp.confidence),
      categorySlug: after.category_slug,
      organization: after.organization,
      location: after.location,
      compensation: {
        type: after.compensation_type,
        status: after.compensation_status,
        amountMin: after.amount_min === null ? null : Number(after.amount_min),
        amountMax: after.amount_max === null ? null : Number(after.amount_max),
        currency: after.currency,
        verified: !unverified.includes("compensation"),
      },
      nextDeadline: future[0] ?? null,
      latestPastDeadline: past.at(-1) ?? null,
      redFlags: flags,
      cancelled,
      unverified,
    },
    ctx.prefs,
  );
  await client.query(
    `UPDATE opportunities
     SET next_deadline_at = $2, priority = $3, priority_score = $4, priority_reasons = $5, red_flags = $6, unverified_fields = $7,
         organization = COALESCE(organization, $8), sender_role = COALESCE(sender_role, $9), contact_phone = COALESCE(contact_phone, $10)
     WHERE id = $1`,
    [
      oppId,
      future[0] ?? null,
      priority.priority,
      priority.score,
      JSON.stringify(priority.reasons),
      JSON.stringify(flags),
      unverified,
      nul(v.text.organization.value),
      nul(v.text.sender_role.value),
      nul(v.text.contact_phone.value),
    ],
  );

  const role = v.cancellation
    ? "cancellation"
    : changes.length > 0
      ? "change"
      : triage.classification === "negotiation_or_contract"
        ? "contract"
        : "follow_up";
  await client.query(
    `INSERT INTO opportunity_emails (opportunity_id, email_id, role, linked_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [oppId, email.id, role, linkedBy],
  );
  if (linkedBy === "ai_match") {
    await client.query(`INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES ($1, 'ai', 'linked_by_sender', $2)`, [
      oppId,
      JSON.stringify({ emailId: email.id, note: "Linked because it's from the same sender. Check it belongs to this offer." }),
    ]);
  }
  await touchOpportunity(client, opp, email);
  ctx.report.updated++;
}

// --- Helpers -------------------------------------------------------------------------------------------

async function loadPreferences(): Promise<Preferences> {
  const rows = await query<{ key: string; value: unknown }>(`SELECT key, value FROM preferences`);
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const list = (k: string) => {
    const v = get(k);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  const fees = get("minimum_fee_inr");
  const minimumFeeInr: Record<string, number> = {};
  if (fees && typeof fees === "object" && !Array.isArray(fees)) {
    for (const [k, val] of Object.entries(fees as Record<string, unknown>)) if (typeof val === "number" && val > 0) minimumFeeInr[k] = val;
  }
  return {
    ...EMPTY_PREFERENCES,
    preferredCategories: list("preferred_categories"),
    preferredBrands: list("preferred_brands"),
    avoidedBrands: list("avoided_brands"),
    preferredLocations: list("preferred_locations"),
    minimumFeeInr,
  };
}

async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]!);
    }),
  );
}
