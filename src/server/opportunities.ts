// Read-only queries for the opportunity, review and AI-status screens.
import { query } from "@/lib/db.ts";
import type { RedFlag } from "@/lib/ai/redflags.ts";
import { MAX_AI_ATTEMPTS } from "@/lib/ai/process.ts";
import { SCHEDULER_ID, type AiStatus } from "@/lib/scheduler.ts";

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
};

const PRIORITY_ORDER = `CASE o.priority WHEN 'high' THEN 0 WHEN 'needs_review' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export async function listOpportunities(opts: { onlyReview?: boolean; limit?: number } = {}): Promise<OpportunityCard[]> {
  return query<OpportunityCard>(
    `SELECT o.id, o.title, o.summary, c.name AS category_name, o.organization, o.sender_name, o.sender_email,
            o.compensation_type, o.compensation_status, o.amount_min, o.amount_max, o.currency, o.payment_terms,
            o.deliverables, o.location, o.reply_by_at, o.event_start_at, o.next_deadline_at, o.priority,
            o.priority_reasons, o.red_flags, o.status, o.from_historical, o.unverified_fields,
            d.title AS possible_duplicate_title,
            (SELECT count(*) FROM opportunity_emails oe WHERE oe.opportunity_id = o.id) AS email_count,
            o.last_activity_at
     FROM opportunities o
     LEFT JOIN categories c ON c.id = o.category_id
     LEFT JOIN opportunities d ON d.id = o.possible_duplicate_of
     WHERE NOT o.is_irrelevant AND ($1::boolean IS NOT TRUE OR o.priority = 'needs_review')
     ORDER BY ${PRIORITY_ORDER}, o.next_deadline_at ASC NULLS LAST, o.last_activity_at DESC
     LIMIT $2`,
    [opts.onlyReview ?? false, opts.limit ?? 200],
  );
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
