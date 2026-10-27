// What admins can do from the dashboard. Every change runs in a transaction, is logged on the
// opportunity's timeline with who did it, and ends with a fresh priority. Nothing here sends email.
import type pg from "pg";
import { getPool } from "@/lib/db.ts";
import { rescoreOpportunity } from "@/lib/ai/rescore.ts";
import {
  cleanText,
  EditError,
  parseAmount,
  parseCurrency,
  parseDayIST,
  parseLines,
  parseNote,
  parseReminderTime,
  parseStatus,
  STATUS_LABEL,
} from "@/lib/edits.ts";
import { formatMoney } from "@/lib/ai/priority.ts";
import type { AdminSession } from "@/server/session.ts";

export { EditError };

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

async function log(c: pg.PoolClient, oppId: string, admin: AdminSession, kind: string, detail: Record<string, unknown>) {
  await c.query(`INSERT INTO activities (opportunity_id, actor_type, actor_user_id, kind, detail) VALUES ($1, 'user', $2, $3, $4)`, [
    oppId,
    admin.userId,
    kind,
    JSON.stringify(detail),
  ]);
}

type Locked = {
  id: string;
  title: string;
  status: string;
  category_id: string | null;
  possible_duplicate_of: string | null;
  is_irrelevant: boolean;
  sender_email: string | null;
  classification: string | null;
  [column: string]: unknown;
};

async function lock(c: pg.PoolClient, id: string): Promise<Locked> {
  const r = await c.query<Locked>(`SELECT * FROM opportunities WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rows[0]) throw new EditError("That opportunity no longer exists.");
  return r.rows[0];
}

// --- Status, notes, snooze, review -------------------------------------------------------------------

export async function changeStatus(admin: AdminSession, id: string, raw: unknown): Promise<string> {
  const status = parseStatus(raw);
  return tx(async (c) => {
    const o = await lock(c, id);
    if (o.status === status) return "Status unchanged.";
    await c.query(`UPDATE opportunities SET status = $2, is_read = true WHERE id = $1`, [id, status]);
    await log(c, id, admin, "status_changed", { from: o.status, to: status });
    return `Status set to ${STATUS_LABEL[status]}.`;
  });
}

export async function addNote(admin: AdminSession, id: string, raw: unknown): Promise<string> {
  const text = parseNote(raw);
  return tx(async (c) => {
    await lock(c, id);
    await log(c, id, admin, "note", { text });
    return "Note added.";
  });
}

export async function snooze(admin: AdminSession, id: string, rawDays: unknown): Promise<string> {
  const days = rawDays === "clear" ? 0 : Number(rawDays);
  if (![0, 1, 3, 7].includes(days)) throw new EditError("Choose how long to snooze.");
  return tx(async (c) => {
    await lock(c, id);
    if (days === 0) {
      await c.query(`UPDATE opportunities SET snoozed_until = NULL WHERE id = $1`, [id]);
      await log(c, id, admin, "unsnoozed", {});
      return "Back in the list.";
    }
    await c.query(`UPDATE opportunities SET snoozed_until = now() + make_interval(days => $2) WHERE id = $1`, [id, days]);
    await log(c, id, admin, "snoozed", { days });
    return `Snoozed for ${days === 1 ? "a day" : `${days} days`}. It's hidden from the overview until then.`;
  });
}

export async function reviewOpportunity(admin: AdminSession, id: string, decision: unknown): Promise<string> {
  return tx(async (c) => {
    const o = await lock(c, id);
    if (decision === "genuine") {
      await c.query(`UPDATE opportunities SET review_cleared = true, is_read = true WHERE id = $1`, [id]);
      await log(c, id, admin, "review_cleared", {});
      await rescoreOpportunity(c, id);
      return "Marked as checked. Its warnings stay visible, but it's out of Needs review.";
    }
    if (decision === "not_relevant") {
      await c.query(`UPDATE opportunities SET is_irrelevant = true WHERE id = $1`, [id]);
      await c.query(
        `INSERT INTO corrections (opportunity_id, field_name, old_value, new_value, corrected_by) VALUES ($1, 'classification', $2, '"unrelated"', $3)`,
        [id, JSON.stringify(o.classification), admin.userId],
      );
      await log(c, id, admin, "marked_not_relevant", {});
      return "Moved out of the lists. Future mail like this will be sorted the same way.";
    }
    if (decision === "restore") {
      await c.query(`UPDATE opportunities SET is_irrelevant = false WHERE id = $1`, [id]);
      await log(c, id, admin, "restored", {});
      return "Back in the lists.";
    }
    throw new EditError("Unknown review choice.");
  });
}

// --- Duplicates ---------------------------------------------------------------------------------------

export async function resolveDuplicate(admin: AdminSession, id: string, decision: unknown): Promise<{ message: string; goTo: string }> {
  return tx(async (c) => {
    const o = await lock(c, id);
    if (!o.possible_duplicate_of) throw new EditError("This card isn't marked as a possible duplicate.");
    const targetId = o.possible_duplicate_of;
    if (decision === "dismiss") {
      await c.query(`UPDATE opportunities SET possible_duplicate_of = NULL WHERE id = $1`, [id]);
      await log(c, id, admin, "duplicate_dismissed", { of: targetId });
      return { message: "Kept as a separate offer.", goTo: id };
    }
    if (decision !== "merge") throw new EditError("Unknown choice.");
    const target = await lock(c, targetId);
    const moved = await c.query(
      `INSERT INTO opportunity_emails (opportunity_id, email_id, role, linked_by)
       SELECT $2, email_id, CASE WHEN role = 'original' THEN 'follow_up' ELSE role END, 'admin'
       FROM opportunity_emails WHERE opportunity_id = $1
       ON CONFLICT DO NOTHING`,
      [id, targetId],
    );
    await c.query(
      `UPDATE opportunities t SET last_activity_at = GREATEST(t.last_activity_at, s.last_activity_at), is_read = false
       FROM opportunities s WHERE t.id = $1 AND s.id = $2`,
      [targetId, id],
    );
    await log(c, targetId, admin, "merged", { fromTitle: o.title, emails: moved.rowCount ?? 0 });
    // The merged card's own history goes with it; its emails now live on the other card.
    await c.query(`DELETE FROM opportunities WHERE id = $1`, [id]);
    await rescoreOpportunity(c, targetId);
    return { message: `Merged into “${target.title}”.`, goTo: targetId };
  });
}

// --- Corrections --------------------------------------------------------------------------------------

/** Editable fields: column, the name its values are stored under, and the label people see. */
const TEXT_FIELDS: Record<string, { column: string; label: string; max: number }> = {
  organization: { column: "organization", label: "Company", max: 200 },
  sender_role: { column: "sender_role", label: "Sender's role", max: 200 },
  contact_phone: { column: "contact_phone", label: "Phone", max: 40 },
  location: { column: "location", label: "Location", max: 200 },
  usage_rights: { column: "usage_rights", label: "Usage rights", max: 500 },
  exclusivity: { column: "exclusivity", label: "Exclusivity", max: 500 },
  expenses_covered: { column: "expenses_covered", label: "Expenses covered", max: 500 },
  requested_action: { column: "requested_action", label: "Their next step", max: 500 },
};

const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "not stated" : String(v));

async function replaceFieldValues(
  c: pg.PoolClient,
  oppId: string,
  names: string[],
  insert: { name: string; text: string | null; json: unknown } | null,
  admin: AdminSession,
) {
  await c.query(`UPDATE extracted_fields SET is_current = false WHERE opportunity_id = $1 AND field_name = ANY($2::text[]) AND is_current`, [
    oppId,
    names,
  ]);
  if (insert) {
    await c.query(
      `INSERT INTO extracted_fields (opportunity_id, field_name, value_text, value_json, is_verified, confidence, corrected_by, corrected_at)
       VALUES ($1, $2, $3, $4, true, 1, $5, now())`,
      [oppId, insert.name, insert.text, insert.json === null ? null : JSON.stringify(insert.json), admin.userId],
    );
  }
}

async function recordCorrection(
  c: pg.PoolClient,
  oppId: string,
  admin: AdminSession,
  field: string,
  label: string,
  from: unknown,
  to: unknown,
  unverifiedKey: string | null,
) {
  if (unverifiedKey) {
    await c.query(`UPDATE opportunities SET unverified_fields = array_remove(unverified_fields, $2) WHERE id = $1`, [oppId, unverifiedKey]);
  }
  await c.query(`INSERT INTO corrections (opportunity_id, field_name, old_value, new_value, corrected_by) VALUES ($1, $2, $3, $4, $5)`, [
    oppId,
    field,
    JSON.stringify(from ?? null),
    JSON.stringify(to ?? null),
    admin.userId,
  ]);
  await log(c, oppId, admin, "corrected", { field: label, from: shown(from), to: shown(to) });
}

export async function correctField(admin: AdminSession, id: string, form: FormData): Promise<string> {
  const field = String(form.get("field") ?? "");

  return tx(async (c) => {
    const o = await lock(c, id);

    if (field in TEXT_FIELDS) {
      const f = TEXT_FIELDS[field]!;
      const value = cleanText(form.get("value"), f.max);
      const before = (o[f.column] as string | null) ?? null;
      if (before === value) return `${f.label} unchanged.`;
      await c.query(`UPDATE opportunities SET ${f.column} = $2 WHERE id = $1`, [id, value]);
      await replaceFieldValues(c, id, [field], value ? { name: field, text: value, json: null } : null, admin);
      await recordCorrection(c, id, admin, field, f.label, before, value, field);
    } else if (field === "title") {
      const value = cleanText(form.get("value"), 120);
      if (!value) throw new EditError("A title can't be empty.");
      await c.query(`UPDATE opportunities SET title = $2 WHERE id = $1`, [id, value]);
      await recordCorrection(c, id, admin, "title", "Title", o.title, value, null);
    } else if (field === "category") {
      const slug = String(form.get("value") ?? "");
      const cat = await c.query<{ id: string; name: string }>(`SELECT id, name FROM categories WHERE slug = $1 AND is_enabled`, [slug]);
      if (!cat.rows[0]) throw new EditError("Choose one of the listed categories.");
      const before = o.category_id ? (await c.query<{ name: string }>(`SELECT name FROM categories WHERE id = $1`, [o.category_id])).rows[0]?.name : null;
      await c.query(`UPDATE opportunities SET category_id = $2 WHERE id = $1`, [id, cat.rows[0].id]);
      await recordCorrection(c, id, admin, "category", "Category", before ?? null, cat.rows[0].name, null);
    } else if (field === "pay") {
      const type = String(form.get("type") ?? "");
      if (!["paid", "unpaid", "barter", "commission", "affiliate", "unspecified"].includes(type)) throw new EditError("Choose how she's paid.");
      let min = parseAmount(form.get("amount_min"));
      let max = parseAmount(form.get("amount_max")) ?? min;
      if (min === null && max !== null) min = max;
      if (min !== null && max !== null && max < min) [min, max] = [max, min];
      const currency = parseCurrency(form.get("currency"));
      const status = min === null ? "not_disclosed" : max !== min ? "range" : "confirmed";
      const describe = (t: string, a: number | null, b: number | null, cur: string) =>
        a === null ? (t === "barter" ? "Barter" : t === "unpaid" ? "Unpaid" : "Not stated") : b !== null && b !== a ? `${formatMoney(a, cur)}–${formatMoney(b, cur)}` : formatMoney(a, cur);
      const before = describe(
        String(o.compensation_type),
        o.amount_min === null ? null : Number(o.amount_min),
        o.amount_max === null ? null : Number(o.amount_max),
        String(o.currency),
      );
      const after = describe(type, min, max, currency);
      await c.query(
        `UPDATE opportunities SET compensation_type = $2, compensation_status = $3, amount_min = $4, amount_max = $5, currency = $6 WHERE id = $1`,
        [id, type, status, min, max, currency],
      );
      await replaceFieldValues(c, id, ["compensation"], { name: "compensation", text: after, json: { type, status, amountMin: min, amountMax: max, currency } }, admin);
      await recordCorrection(c, id, admin, "compensation", "Pay", before, after, "compensation");
    } else if (field === "deliverables") {
      const items = parseLines(form.get("value"));
      const before = (o.deliverables as Array<{ item: string }>).map((d) => d.item).join("; ");
      await c.query(`UPDATE opportunities SET deliverables = $2 WHERE id = $1`, [id, JSON.stringify(items.map((item) => ({ item, verified: true })))]);
      await replaceFieldValues(
        c,
        id,
        ["deliverables"],
        items.length ? { name: "deliverables", text: items.join("; "), json: items.map((item) => ({ item, verified: true })) } : null,
        admin,
      );
      await recordCorrection(c, id, admin, "deliverables", "Deliverables", before || null, items.join("; ") || null, "deliverables");
    } else if (field === "reply_by" || field === "event_start") {
      const isReply = field === "reply_by";
      const at = parseDayIST(form.get("value"), isReply);
      const column = isReply ? "reply_by_at" : "event_start_at";
      const before = o[column] as Date | null;
      if (!isReply && at && o.event_end_at && at.getTime() > (o.event_end_at as Date).getTime()) {
        await c.query(`UPDATE opportunities SET event_end_at = NULL WHERE id = $1`, [id]); // keep dates in order
      }
      await c.query(`UPDATE opportunities SET ${column} = $2 WHERE id = $1`, [id, at]);
      const names = isReply ? ["date:reply_by", "date:deadline"] : ["date:event_start", "date:shoot", "date:audition"];
      await replaceFieldValues(
        c,
        id,
        names,
        at ? { name: names[0]!, text: DAY.format(at), json: { at: at.toISOString() } } : null,
        admin,
      );
      await recordCorrection(c, id, admin, field, isReply ? "Reply by" : "Event date", before ? DAY.format(before) : null, at ? DAY.format(at) : null, "dates");
    } else {
      throw new EditError("That detail can't be edited.");
    }

    await c.query(`UPDATE opportunities SET is_read = true WHERE id = $1`, [id]);
    await rescoreOpportunity(c, id);
    return "Saved. Priority was recalculated.";
  });
}

// --- Review queue emails --------------------------------------------------------------------------------

type ReviewEmailRow = {
  id: string;
  gmail_account_id: string;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  received_at: Date;
  is_historical: boolean;
  classification: string | null;
  processing_state: string;
};

/**
 * "This is an offer": with AI sorting on, the email goes back for full extraction as an offer;
 * without it, a basic card is made straight away for the admin to fill in.
 */
export async function reviewEmail(
  admin: AdminSession,
  emailId: string,
  decision: unknown,
  aiEnabled: boolean,
): Promise<{ message: string; opportunityId?: string }> {
  return tx(async (c) => {
    const r = await c.query<ReviewEmailRow>(
      `SELECT id, gmail_account_id, subject, from_name, from_email, received_at, is_historical, classification, processing_state
       FROM emails WHERE id = $1 FOR UPDATE`,
      [emailId],
    );
    const e = r.rows[0];
    if (!e) throw new EditError("That email no longer exists.");

    if (decision === "not_offer") {
      await c.query(`UPDATE emails SET processing_state = 'processed', classification = 'unrelated', processed_at = now() WHERE id = $1`, [emailId]);
      await c.query(`INSERT INTO corrections (email_id, field_name, old_value, new_value, corrected_by) VALUES ($1, 'classification', $2, '"unrelated"', $3)`, [
        emailId,
        JSON.stringify(e.classification),
        admin.userId,
      ]);
      return { message: "Marked as not an offer. Mail like this from that sender will be sorted the same way." };
    }
    if (decision !== "offer") throw new EditError("Unknown choice.");

    await c.query(`INSERT INTO corrections (email_id, field_name, old_value, new_value, corrected_by) VALUES ($1, 'classification', $2, '"new_opportunity"', $3)`, [
      emailId,
      JSON.stringify(e.classification),
      admin.userId,
    ]);

    if (aiEnabled) {
      await c.query(
        `UPDATE emails SET classification = 'new_opportunity', classification_confidence = 1, classification_reason = 'Marked as an offer by her team.',
                processing_state = 'pending', processing_attempts = 0, processing_not_before = NULL, processing_error = NULL
         WHERE id = $1`,
        [emailId],
      );
      return { message: "Sent back to be read as an offer. Its card appears in Opportunities within a minute or two." };
    }

    const created = await c.query<{ id: string }>(
      `INSERT INTO opportunities (gmail_account_id, title, sender_name, sender_email, status, priority, classification, confidence,
                                  review_cleared, first_received_at, last_activity_at, from_historical, missing_information)
       VALUES ($1, $2, $3, $4, 'new', 'medium', 'new_opportunity', 1, true, $5, $5, $6, '["Fee", "Dates"]')
       RETURNING id`,
      [e.gmail_account_id, (e.subject ?? "").trim().slice(0, 120) || "Untitled offer", e.from_name, e.from_email, e.received_at, e.is_historical],
    );
    const oppId = created.rows[0]!.id;
    await c.query(`INSERT INTO opportunity_emails (opportunity_id, email_id, role, linked_by) VALUES ($1, $2, 'original', 'admin')`, [oppId, emailId]);
    await c.query(`UPDATE emails SET processing_state = 'processed', classification = 'new_opportunity', processed_at = now() WHERE id = $1`, [emailId]);
    await log(c, oppId, admin, "created_by_admin", { emailId });
    await rescoreOpportunity(c, oppId);
    return { message: "Card created. Fill in the pay and dates so it's scored properly.", opportunityId: oppId };
  });
}

// --- Flag for her, her answer, reminders -----------------------------------------------------------------

const ANSWERS = ["interested", "pass", "questions"] as const;
type Answer = (typeof ANSWERS)[number];
const ANSWER_DONE: Record<Answer, string> = {
  interested: "Saved: she's interested. Her team has been told.",
  pass: "Saved: she'll pass. Her team has been told.",
  questions: "Saved: she has questions. Her team has been told.",
};

/** Which admin is the actress, if someone has chosen in Settings. */
export async function talentEmail(c: Pick<pg.PoolClient, "query">): Promise<string | null> {
  const r = await c.query<{ value: unknown }>(`SELECT value FROM preferences WHERE key = 'talent_email'`);
  const v = r.rows[0]?.value;
  return typeof v === "string" ? v : null;
}

/** Puts the offer to her: she gets it in Telegram, on her phone and in Spotlight, with answer buttons. */
export async function flagForHer(admin: AdminSession, id: string, rawNote: unknown): Promise<string> {
  const note = cleanText(rawNote, 300);
  return tx(async (c) => {
    const o = await lock(c, id);
    if (o.is_irrelevant) throw new EditError("This card is marked not relevant. Put it back first.");
    const talent = await talentEmail(c);
    if (!talent) throw new EditError("Choose who the actress is in Settings first.");
    await c.query(
      `UPDATE opportunities SET flagged_for_talent_at = now(), flagged_by = $2, talent_response = NULL, talent_response_note = NULL,
              talent_responded_at = NULL, is_read = true
       WHERE id = $1`,
      [id, admin.userId],
    );
    await log(c, id, admin, "flagged_for_her", note ? { note } : {});
    await rescoreOpportunity(c, id);
    const signedIn = (await c.query(`SELECT 1 FROM users WHERE email = $1`, [talent])).rowCount;
    return signedIn
      ? "Sent to her. Her answer will show here and reach you as an alert."
      : "Flagged. She'll see it once she signs in to Spotlight; connect her Telegram in Settings so it reaches her phone.";
  });
}

export async function withdrawFlag(admin: AdminSession, id: string): Promise<string> {
  return tx(async (c) => {
    const o = await lock(c, id);
    if (!o.flagged_for_talent_at) return "It wasn't flagged for her.";
    await c.query(
      `UPDATE opportunities SET flagged_for_talent_at = NULL, flagged_by = NULL, talent_response = NULL, talent_response_note = NULL, talent_responded_at = NULL
       WHERE id = $1`,
      [id],
    );
    await log(c, id, admin, "flag_withdrawn", {});
    await rescoreOpportunity(c, id);
    return "No longer waiting for her answer.";
  });
}

/**
 * Her answer, from Spotlight or a Telegram button. "Interested" moves a fresh card to Interested;
 * nothing is ever accepted or declined for her.
 */
export async function answerForHer(
  actor: AdminSession,
  id: string,
  rawAnswer: unknown,
  rawNote: unknown,
  via: "spotlight" | "telegram" | "claude",
): Promise<string> {
  const answer = ANSWERS.find((a) => a === rawAnswer);
  if (!answer) throw new EditError("Choose Interested, Pass or Questions.");
  const note = rawNote === null || rawNote === undefined || rawNote === "" ? null : parseNote(rawNote).slice(0, 1000);
  return tx(async (c) => {
    const o = await lock(c, id);
    if (!o.flagged_for_talent_at) throw new EditError("This offer isn't waiting for her answer.");
    await c.query(
      `UPDATE opportunities SET talent_response = $2, talent_response_note = $3, talent_responded_at = now() WHERE id = $1`,
      [id, answer, note],
    );
    await log(c, id, actor, "her_answer", { answer, ...(note ? { note } : {}), via });
    if (answer === "interested" && (o.status === "new" || o.status === "reviewed")) {
      await c.query(`UPDATE opportunities SET status = 'interested' WHERE id = $1`, [id]);
      await log(c, id, actor, "status_changed", { from: o.status, to: "interested", because: "She said she's interested" });
    }
    await rescoreOpportunity(c, id);
    return ANSWER_DONE[answer];
  });
}

export async function addReminder(admin: AdminSession, id: string, form: FormData): Promise<string> {
  const at = parseReminderTime(form.get("day"), form.get("time"));
  const note = cleanText(form.get("note"), 120);
  const forBoth = form.get("who") === "both";
  return tx(async (c) => {
    await lock(c, id);
    const open = await c.query(`SELECT 1 FROM reminders WHERE opportunity_id = $1 AND status = 'pending'`, [id]);
    if ((open.rowCount ?? 0) >= 10) throw new EditError("This card already has 10 reminders waiting.");
    await c.query(
      `INSERT INTO reminders (opportunity_id, kind, due_at, dedupe_key, created_by, for_user, note)
       VALUES ($1, 'custom', $2, 'custom:' || gen_random_uuid(), $3, $4, $5)`,
      [id, at, admin.userId, forBoth ? null : admin.userId, note],
    );
    await log(c, id, admin, "reminder_set", { at: at.toISOString(), forBoth, ...(note ? { note } : {}) });
    await rescoreOpportunity(c, id);
    return `Reminder set for ${REMINDER_TIME.format(at)}${forBoth ? " for both of you" : ""}.`;
  });
}

export async function cancelReminder(admin: AdminSession, id: string, reminderId: unknown): Promise<string> {
  if (typeof reminderId !== "string" || !/^[0-9a-f-]{36}$/i.test(reminderId)) throw new EditError("That reminder no longer exists.");
  return tx(async (c) => {
    await lock(c, id);
    const r = await c.query(`UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND opportunity_id = $2 AND status = 'pending'`, [reminderId, id]);
    if (!r.rowCount) throw new EditError("That reminder already went off or was cancelled.");
    await log(c, id, admin, "reminder_cancelled", {});
    await rescoreOpportunity(c, id);
    return "Reminder cancelled.";
  });
}

const REMINDER_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * "Sort them again": emails set aside because Claude couldn't be reached or refused the request
 * (not because the AI was unsure) go back to be sorted automatically.
 */
export async function retryFailedSorting(admin: AdminSession): Promise<string> {
  return tx(async (c) => {
    const r = await c.query(
      `UPDATE emails SET processing_state = 'pending', processing_attempts = 0, processing_error = NULL, processing_not_before = NULL
       WHERE processing_state = 'needs_review' AND processing_error LIKE 'Couldn''t be sorted automatically:%'`,
    );
    const n = r.rowCount ?? 0;
    if (n === 0) return "Nothing to sort again.";
    await c.query(`INSERT INTO activities (actor_type, actor_user_id, kind, detail) VALUES ('user', $1, 'sorting_retried', $2)`, [
      admin.userId,
      JSON.stringify({ emails: n }),
    ]);
    return `${n} ${n === 1 ? "email goes" : "emails go"} back to be sorted. They're read a few at a time, so give it a few minutes.`;
  });
}

export async function markOpened(id: string): Promise<void> {
  await getPool().query(`UPDATE opportunities SET is_read = true WHERE id = $1 AND NOT is_read`, [id]);
}
