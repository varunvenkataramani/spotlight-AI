// Everything the opportunity detail page shows, read in one place.
import { query } from "@/lib/db.ts";
import type { RedFlag } from "@/lib/ai/redflags.ts";

export type Detail = {
  id: string;
  title: string;
  summary: string | null;
  description: string | null;
  category_slug: string | null;
  category_name: string | null;
  organization: string | null;
  sender_name: string | null;
  sender_email: string | null;
  sender_role: string | null;
  contact_phone: string | null;
  compensation_type: string;
  compensation_status: string;
  amount_min: string | null;
  amount_max: string | null;
  currency: string;
  payment_terms: string | null;
  is_negotiable: boolean | null;
  deliverables: Array<{ item: string; verified: boolean }>;
  usage_rights: string | null;
  exclusivity: string | null;
  expenses_covered: string | null;
  location: string | null;
  format: string;
  reply_by_at: Date | null;
  event_start_at: Date | null;
  event_end_at: Date | null;
  next_deadline_at: Date | null;
  requested_action: string | null;
  missing_information: string[];
  priority: "high" | "medium" | "low" | "needs_review";
  priority_reasons: string[];
  red_flags: RedFlag[];
  status: string;
  is_irrelevant: boolean;
  is_read: boolean;
  snoozed_until: Date | null;
  review_cleared: boolean;
  from_historical: boolean;
  unverified_fields: string[];
  possible_duplicate_of: string | null;
  duplicate_title: string | null;
  first_received_at: Date | null;
  last_activity_at: Date;
};

export type FieldSource = {
  field_name: string;
  value_text: string | null;
  source_quote: string | null;
  is_verified: boolean;
  email_id: string | null;
  corrected_by_name: string | null;
};

export type ThreadEmail = {
  id: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: string[];
  subject: string | null;
  body_text: string | null;
  received_at: Date;
  role: string;
  linked_by: string;
  attachment_names: string[];
};

export type TimelineItem = {
  id: string;
  actor_type: "system" | "ai" | "user";
  actor_name: string | null;
  kind: string;
  detail: Record<string, unknown>;
  created_at: Date;
};

export async function getDetail(id: string) {
  const rows = await query<Detail>(
    `SELECT o.*, c.slug AS category_slug, c.name AS category_name, d.title AS duplicate_title
     FROM opportunities o
     LEFT JOIN categories c ON c.id = o.category_id
     LEFT JOIN opportunities d ON d.id = o.possible_duplicate_of
     WHERE o.id = $1`,
    [id],
  );
  const opportunity = rows[0];
  if (!opportunity) return null;

  const [sources, emails, timeline, categories] = await Promise.all([
    query<FieldSource>(
      `SELECT f.field_name, f.value_text, f.source_quote, f.is_verified, f.email_id,
              COALESCE(u.name, u.email) AS corrected_by_name
       FROM extracted_fields f LEFT JOIN users u ON u.id = f.corrected_by
       WHERE f.opportunity_id = $1 AND f.is_current
       ORDER BY f.created_at`,
      [id],
    ),
    query<ThreadEmail>(
      `SELECT e.id, e.from_name, e.from_email, e.to_emails, e.subject, e.body_text, e.received_at, oe.role, oe.linked_by,
              e.attachment_names
       FROM opportunity_emails oe JOIN emails e ON e.id = oe.email_id
       WHERE oe.opportunity_id = $1
       ORDER BY e.received_at ASC`,
      [id],
    ),
    query<TimelineItem>(
      `SELECT a.id::text, a.actor_type, COALESCE(u.name, u.email) AS actor_name, a.kind, a.detail, a.created_at
       FROM activities a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.opportunity_id = $1
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 100`,
      [id],
    ),
    query<{ slug: string; name: string }>(`SELECT slug, name FROM categories WHERE is_enabled ORDER BY sort_order, name`),
  ]);
  return { opportunity, sources, emails, timeline, categories };
}
