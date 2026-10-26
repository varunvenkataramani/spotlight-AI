// Read-only queries for the opportunity, review and AI-status screens.
import { query } from "@/lib/db.ts";
import type { RedFlag } from "@/lib/ai/redflags.ts";
import { MAX_AI_ATTEMPTS } from "@/lib/ai/process.ts";
import { SCHEDULER_ID, type AiStatus } from "@/lib/scheduler.ts";
import { DEFAULT_FILTERS, statusesFor, type ListFilters } from "@/lib/edits.ts";

export type OpportunityCard = {
  id: string;
  title: string;
  summary: string | null;
  category_name: string | null;
  organization: string | null;
  sender_name: string | null;
  sender_email: string | null;
  compensation_type: string;
  compensation_status: string;
  amount_min: string | null;
  amount_max: string | null;
  currency: string;
  payment_terms: string | null;
  deliverables: Array<{ item: string; verified: boolean }>;
  location: string | null;
  reply_by_at: Date | null;
  event_start_at: Date | null;
  next_deadline_at: Date | null;
  priority: "high" | "medium" | "low" | "needs_review";
  priority_reasons: string[];
  red_flags: RedFlag[];
  status: string;
  from_historical: boolean;
  unverified_fields: string[];
  possible_duplicate_title: string | null;
  email_count: string;
  last_activity_at: Date;
  snoozed_until: Date | null;
  is_read: boolean;
};

const PRIORITY_ORDER = `CASE o.priority WHEN 'high' THEN 0 WHEN 'needs_review' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

const ORDER: Record<ListFilters["sort"], string> = {
  urgent: `${PRIORITY_ORDER}, o.next_deadline_at ASC NULLS LAST, o.last_activity_at DESC`,
  newest: `o.first_received_at DESC NULLS LAST, o.created_at DESC`,
  pay: `COALESCE(o.amount_max, o.amount_min) DESC NULLS LAST, ${PRIORITY_ORDER}`,
};

/** Escapes a search phrase for ILIKE, so % and _ are matched literally. */
const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listOpportunities(
  opts: { filters?: ListFilters; onlyReview?: boolean; attention?: boolean; limit?: number } = {},
): Promise<OpportunityCard[]> {
  const f = opts.filters ?? DEFAULT_FILTERS;
  return query<OpportunityCard>(
    `SELECT o.id, o.title, o.summary, c.name AS category_name, o.organization, o.sender_name, o.sender_email,
            o.compensation_type, o.compensation_status, o.amount_min, o.amount_max, o.currency, o.payment_terms,
            o.deliverables, o.location, o.reply_by_at, o.event_start_at, o.next_deadline_at, o.priority,
            o.priority_reasons, o.red_flags, o.status, o.from_historical, o.unverified_fields,
            d.title AS possible_duplicate_title,
            (SELECT count(*) FROM opportunity_emails oe WHERE oe.opportunity_id = o.id) AS email_count,
            o.last_activity_at, o.snoozed_until, o.is_read
     FROM opportunities o
     LEFT JOIN categories c ON c.id = o.category_id
     LEFT JOIN opportunities d ON d.id = o.possible_duplicate_of
     WHERE NOT o.is_irrelevant
       AND ($1::boolean IS NOT TRUE OR o.priority = 'needs_review')
       AND o.status = ANY($3::text[])
       AND ($4::text IS NULL OR c.slug = $4::text)
       AND ($5::text IS NULL OR o.priority = $5::text)
       AND ($6::text = '' OR o.search @@ plainto_tsquery('simple', $6::text)
            OR o.title ILIKE $7 ESCAPE '\\' OR o.organization ILIKE $7 ESCAPE '\\'
            OR o.sender_name ILIKE $7 ESCAPE '\\' OR o.sender_email ILIKE $7 ESCAPE '\\')
       AND ($8::boolean IS NOT TRUE OR (
             (o.priority IN ('high', 'needs_review') OR o.next_deadline_at < now() + interval '7 days' OR NOT o.is_read)
             AND (o.snoozed_until IS NULL OR o.snoozed_until < now())))
     ORDER BY ${ORDER[f.sort]}
     LIMIT $2`,
    [
      opts.onlyReview ?? false,
      opts.limit ?? 200,
      [...statusesFor(opts.onlyReview || opts.attention ? "active" : f.show)],
      f.category,
      f.priority,
      f.q,
      likeTerm(f.q),
      opts.attention ?? false,
    ],
  );
}

export type RecentChange = { opportunity_id: string; title: string; kind: string; detail: Record<string, unknown>; created_at: Date };

/** What changed lately without anyone doing it: their emails moving fees or dates, cancellations, their replies. */
export async function listRecentChanges(limit = 6): Promise<RecentChange[]> {
  return query<RecentChange>(
    `SELECT a.opportunity_id, o.title, a.kind, a.detail, a.created_at
     FROM activities a JOIN opportunities o ON o.id = a.opportunity_id
     WHERE a.actor_type IN ('ai', 'system') AND a.kind IN ('change_detected', 'cancellation_detected', 'status_changed', 'created')
       AND a.created_at > now() - interval '14 days' AND NOT o.is_irrelevant
     ORDER BY a.created_at DESC LIMIT $1`,
    [limit],
  );
}

export async function listCategories(): Promise<Array<{ slug: string; name: string }>> {
  return query(`SELECT slug, name FROM categories WHERE is_enabled ORDER BY sort_order, name`);
}

export type ReviewEmail = {
  id: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: Date;
  classification: string | null;
  classification_confidence: string | null;
  classification_reason: string | null;
  processing_error: string | null;
};

export async function listReviewEmails(limit = 100): Promise<ReviewEmail[]> {
  return query<ReviewEmail>(
    `SELECT id, from_name, from_email, subject, snippet, received_at, classification, classification_confidence,
            classification_reason, processing_error
     FROM emails WHERE processing_state = 'needs_review'
     ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
}

export type AiOverview = {
  keyConfigured: boolean;
  status: AiStatus | null;
  waiting: number;
  sorted: number;
  needsReview: number;
  retrying: number;
  opportunities: number;
  calls30d: number;
  inputTokens30d: number;
  outputTokens30d: number;
};

export async function getAiOverview(): Promise<AiOverview> {
  const [counts, usage, beat] = await Promise.all([
    query<{ waiting: string; sorted: string; review: string; retrying: string; opps: string }>(
      `SELECT count(*) FILTER (WHERE processing_state IN ('pending', 'processing')) AS waiting,
              count(*) FILTER (WHERE processing_state = 'processed') AS sorted,
              count(*) FILTER (WHERE processing_state = 'needs_review') AS review,
              count(*) FILTER (WHERE processing_state = 'failed' AND processing_attempts < $1) AS retrying,
              (SELECT count(*) FROM opportunities) AS opps
       FROM emails`,
      [MAX_AI_ATTEMPTS],
    ),
    query<{ calls: string; input: string | null; output: string | null }>(
      `SELECT count(*) AS calls, sum(input_tokens) AS input, sum(output_tokens) AS output
       FROM ai_usage WHERE created_at > now() - interval '30 days'`,
    ),
    query<{ info: { ai?: AiStatus } }>(`SELECT info FROM worker_heartbeats WHERE worker_id = $1`, [SCHEDULER_ID]),
  ]);
  const c = counts[0];
  const u = usage[0];
  return {
    keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    status: beat[0]?.info?.ai ?? null,
    waiting: Number(c?.waiting ?? 0),
    sorted: Number(c?.sorted ?? 0),
    needsReview: Number(c?.review ?? 0),
    retrying: Number(c?.retrying ?? 0),
    opportunities: Number(c?.opps ?? 0),
    calls30d: Number(u?.calls ?? 0),
    inputTokens30d: Number(u?.input ?? 0),
    outputTokens30d: Number(u?.output ?? 0),
  };
}
