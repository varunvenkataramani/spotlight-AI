// Recomputes an opportunity's next deadline and priority from what is stored now: its columns,
// its current extracted dates, its warnings and an admin's review. Used after AI updates and
// after every manual correction, so both always score the same way.
import type pg from "pg";
import { computePriority, EMPTY_PREFERENCES, type Preferences } from "./priority.ts";
import type { RedFlag } from "./redflags.ts";
import type { Classification } from "./schemas.ts";

const DEADLINE_KINDS = ["date:reply_by", "date:deadline", "date:audition", "date:shoot", "date:event_start"];

type Row = {
  classification: Classification | null;
  confidence: string | null;
  category_slug: string | null;
  organization: string | null;
  location: string | null;
  compensation_type: string;
  compensation_status: string;
  amount_min: string | null;
  amount_max: string | null;
  currency: string;
  reply_by_at: Date | null;
  event_start_at: Date | null;
  event_end_at: Date | null;
  red_flags: RedFlag[];
  unverified_fields: string[];
  review_cleared: boolean;
};

export async function loadPreferences(runner: Pick<pg.PoolClient, "query">): Promise<Preferences> {
  const { rows } = await runner.query<{ key: string; value: unknown }>(`SELECT key, value FROM preferences`);
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

/** Must run inside the caller's transaction (pass its client), after the opportunity's facts are updated. */
export async function rescoreOpportunity(client: pg.PoolClient, oppId: string, prefs?: Preferences): Promise<void> {
  const { rows } = await client.query<Row>(
    `SELECT o.classification, o.confidence, c.slug AS category_slug, o.organization, o.location, o.compensation_type,
            o.compensation_status, o.amount_min, o.amount_max, o.currency, o.reply_by_at, o.event_start_at, o.event_end_at,
            o.red_flags, o.unverified_fields, o.review_cleared
     FROM opportunities o LEFT JOIN categories c ON c.id = o.category_id WHERE o.id = $1`,
    [oppId],
  );
  const o = rows[0];
  if (!o) return;

  const dates = await client.query<{ at: string | null }>(
    `SELECT value_json->>'at' AS at FROM extracted_fields
     WHERE opportunity_id = $1 AND is_current AND field_name = ANY($2::text[])`,
    [oppId, DEADLINE_KINDS],
  );
  const now = Date.now();
  const all = [o.reply_by_at, o.event_start_at, ...dates.rows.map((r) => (r.at ? new Date(r.at) : null))].filter(
    (d): d is Date => d !== null && !Number.isNaN(d.getTime()),
  );
  const future = all.filter((d) => d.getTime() >= now).sort((a, b) => a.getTime() - b.getTime());
  const past = [...all, ...(o.event_end_at ? [o.event_end_at] : [])]
    .filter((d) => d.getTime() < now)
    .sort((a, b) => a.getTime() - b.getTime());
  const cancelled =
    ((await client.query(`SELECT 1 FROM activities WHERE opportunity_id = $1 AND kind = 'cancellation_detected' LIMIT 1`, [oppId]))
      .rowCount ?? 0) > 0;

  const priority = computePriority(
    {
      classification: o.classification ?? "new_opportunity",
      confidence: o.confidence === null ? 1 : Number(o.confidence),
      categorySlug: o.category_slug,
      organization: o.organization,
      location: o.location,
      compensation: {
        type: o.compensation_type,
        status: o.compensation_status,
        amountMin: o.amount_min === null ? null : Number(o.amount_min),
        amountMax: o.amount_max === null ? null : Number(o.amount_max),
        currency: o.currency,
        verified: !o.unverified_fields.includes("compensation"),
      },
      nextDeadline: future[0] ?? null,
      latestPastDeadline: past.at(-1) ?? null,
      redFlags: o.red_flags,
      cancelled,
      unverified: o.unverified_fields,
      reviewCleared: o.review_cleared,
    },
    prefs ?? (await loadPreferences(client)),
  );
  await client.query(
    `UPDATE opportunities SET next_deadline_at = $2, priority = $3, priority_score = $4, priority_reasons = $5 WHERE id = $1`,
    [oppId, future[0] ?? null, priority.priority, priority.score, JSON.stringify(priority.reasons)],
  );
}
