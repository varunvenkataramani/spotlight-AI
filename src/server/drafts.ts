// Reply drafts: writing one with Claude, editing, saving it to Gmail, and sending it after an
// admin confirms. Calls to Claude and Google happen outside database transactions, except the
// final send, which holds a lock on the draft so it can only go out once.
import type pg from "pg";
import { getPool, query } from "@/lib/db.ts";
import { ConfigError, readAiConfig, readGmailConfig, readWebConfig } from "@/lib/config.ts";
import { anthropicBaseUrl, callJson, ClaudeApiError } from "@/lib/ai/anthropic.ts";
import {
  DRAFT_MODES,
  InvalidDraftError,
  MODE_LABEL,
  TONES,
  checkDraft,
  draftSchema,
  draftSystemPrompt,
  draftUserMessage,
  placeholdersIn,
  validateDraft,
  type DraftAnswer,
  type DraftMode,
  type DraftWarning,
  type Tone,
} from "@/lib/ai/draft.ts";
import type { EmailForAi } from "@/lib/ai/prompts.ts";
import { rescoreOpportunity } from "@/lib/ai/rescore.ts";
import { EditError } from "@/lib/edits.ts";
import { formatDay, payText } from "@/lib/format.ts";
import { GmailApiError } from "@/lib/gmail/api.ts";
import { buildReplyMime, canCompose, createGmailDraft, isEmailAddress, replySubject, sendGmailMessage } from "@/lib/gmail/compose.ts";
import { ReconnectRequiredError, googleEndpoints } from "@/lib/gmail/google.ts";
import { ensureAccessToken } from "@/lib/gmail/sync.ts";
import type { AdminSession } from "@/server/session.ts";

const OUR_TURN = ["new", "reviewed", "interested", "needs_information", "awaiting_my_response", "reply_drafted"];

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

type ThreadRow = {
  id: string;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  to_emails: string[];
  subject: string | null;
  body_text: string | null;
  received_at: Date;
  gmail_labels: string[];
  attachment_names: string[];
  gmail_thread_id: string;
  rfc_message_id: string | null;
};

async function loadThread(runner: Pick<pg.PoolClient, "query">, oppId: string): Promise<ThreadRow[]> {
  const r = await runner.query<ThreadRow>(
    `SELECT e.id, e.from_name, e.from_email, e.reply_to, e.to_emails, e.subject, e.body_text, e.received_at, e.gmail_labels,
            e.attachment_names, e.gmail_thread_id, e.rfc_message_id
     FROM opportunity_emails oe JOIN emails e ON e.id = oe.email_id
     WHERE oe.opportunity_id = $1 ORDER BY e.received_at ASC`,
    [oppId],
  );
  return r.rows;
}

/** Who the reply goes to: their Reply-To if it's a plain address, otherwise the sender. */
function recipientOf(e: ThreadRow): string | null {
  const replyTo = e.reply_to?.match(/<([^<>]+)>/)?.[1] ?? e.reply_to;
  for (const candidate of [replyTo, e.from_email]) {
    const v = candidate?.trim().toLowerCase();
    if (v && isEmailAddress(v)) return v;
  }
  return null;
}

const toAi = (e: ThreadRow): EmailForAi => ({
  fromName: e.from_name,
  fromEmail: e.from_email,
  replyTo: e.reply_to,
  to: e.to_emails,
  subject: e.subject,
  receivedAt: e.received_at,
  labels: e.gmail_labels,
  attachmentNames: e.attachment_names,
  bodyText: e.body_text ?? "",
});

async function replyPrefs(runner: Pick<pg.PoolClient, "query">): Promise<{ signature: string; facts: string }> {
  const r = await runner.query<{ key: string; value: unknown }>(`SELECT key, value FROM preferences WHERE key IN ('reply_signature', 'reply_facts')`);
  const get = (k: string) => {
    const v = r.rows.find((x) => x.key === k)?.value;
    return typeof v === "string" ? v : "";
  };
  return { signature: get("reply_signature"), facts: get("reply_facts") };
}

type OppRow = {
  id: string;
  title: string;
  organization: string | null;
  sender_name: string | null;
  status: string;
  compensation_type: string;
  compensation_status: string;
  amount_min: string | null;
  amount_max: string | null;
  currency: string;
  payment_terms: string | null;
  deliverables: Array<{ item: string }>;
  reply_by_at: Date | null;
  event_start_at: Date | null;
  event_end_at: Date | null;
  location: string | null;
  usage_rights: string | null;
  exclusivity: string | null;
  expenses_covered: string | null;
  requested_action: string | null;
  missing_information: string[];
  unverified_fields: string[];
  talent_response: string | null;
  talent_response_note: string | null;
};

function offerLines(o: OppRow): string[] {
  const u = (k: string) => (o.unverified_fields.includes(k) ? " (unverified)" : "");
  const lines = [
    `Offer: ${o.title}`,
    `From: ${[o.organization, o.sender_name].filter(Boolean).join(", ") || "not stated"}`,
    `Pay: ${payText(o)}${o.payment_terms ? `, ${o.payment_terms}` : ""}${u("compensation")}`,
    `Deliverables: ${o.deliverables.map((d) => d.item).join("; ") || "not stated"}${u("deliverables")}`,
    `Reply by: ${o.reply_by_at ? formatDay(o.reply_by_at, true) : "not stated"}${u("dates")}`,
    `Shoot or event: ${o.event_start_at ? `${formatDay(o.event_start_at, true)}${o.event_end_at ? ` to ${formatDay(o.event_end_at, true)}` : ""}` : "not stated"}`,
    `Location: ${o.location ?? "not stated"}${u("location")}`,
    `Usage rights: ${o.usage_rights ?? "not stated"}`,
    `Exclusivity: ${o.exclusivity ?? "not stated"}`,
    `Expenses covered: ${o.expenses_covered ?? "not stated"}`,
    `What they asked for: ${o.requested_action ?? "not stated"}`,
  ];
  if (o.missing_information.length) lines.push(`Not stated in their emails: ${o.missing_information.join(", ")}`);
  if (o.talent_response) lines.push(`Her own answer: ${o.talent_response}${o.talent_response_note ? ` (“${o.talent_response_note}”)` : ""}`);
  return lines;
}

const TODAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" });

function parseInstructions(raw: unknown): string | null {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > 1000) throw new EditError("Keep the instructions under 1,000 characters.");
  return text || null;
}

// --- Writing a draft ---------------------------------------------------------------------------------------

export async function createReplyDraft(admin: AdminSession, oppId: string, form: FormData): Promise<{ message: string; draftId: string | null }> {
  const mode = DRAFT_MODES.find((m) => m === form.get("mode")) as DraftMode | undefined;
  const tone = (TONES.find((t) => t === form.get("tone")) ?? "professional") as Tone;
  if (!mode) throw new EditError("Choose what the reply should do.");
  const instructions = parseInstructions(form.get("instructions"));
  if (mode === "custom" && !instructions) throw new EditError("Say what the reply should do in the box below.");
  let ai;
  try {
    ai = readAiConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw new EditError("Reply drafts need AI to be on: add ANTHROPIC_API_KEY in Vercel.");
    throw error;
  }

  // 1. Record the request (and refuse a second one while the first is being written).
  const setup = await tx(async (c) => {
    const o = await c.query<OppRow>(`SELECT * FROM opportunities WHERE id = $1 FOR UPDATE`, [oppId]);
    if (!o.rows[0]) throw new EditError("That opportunity no longer exists.");
    const busy = await c.query(`SELECT 1 FROM drafts WHERE opportunity_id = $1 AND status = 'generating' AND created_at > now() - interval '2 minutes'`, [oppId]);
    if (busy.rowCount) throw new EditError("A reply is already being written for this offer. Reload in a few seconds.");
    const thread = await loadThread(c, oppId);
    const target = thread.at(-1);
    if (!target) throw new EditError("This card has no email to reply to.");
    const to = recipientOf(target);
    if (!to) throw new EditError("Their email has no address Spotlight can reply to.");
    const prefs = await replyPrefs(c);
    const d = await c.query<{ id: string }>(
      `INSERT INTO drafts (opportunity_id, reply_to_email, mode, tone, instructions, to_email, thread_id, subject, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'generating', $9) RETURNING id`,
      [oppId, target.id, mode, tone, instructions, to, target.gmail_thread_id, replySubject(target.subject), admin.userId],
    );
    return { draftId: d.rows[0]!.id, opp: o.rows[0]!, thread, prefs };
  });

  // 2. Ask Claude (no transaction held, no tools offered, emails fenced as data).
  const context = {
    mode,
    tone,
    instructions,
    signature: setup.prefs.signature || admin.name || "",
    facts: setup.prefs.facts,
    offerLines: offerLines(setup.opp),
    emails: setup.thread.map(toAi),
    today: TODAY.format(new Date()),
  };
  let answer: DraftAnswer | null = null;
  let failure: string | null = null;
  for (let attempt = 0; attempt < 2 && !answer && !failure; attempt++) {
    try {
      const r = await callJson({
        apiKey: ai.apiKey,
        baseUrl: anthropicBaseUrl(),
        model: ai.extractModel,
        system: draftSystemPrompt(context),
        user: draftUserMessage(context),
        schema: draftSchema(),
        maxTokens: 1500,
        timeoutMs: 45_000,
      });
      try {
        answer = validateDraft(r.data);
        await query(`INSERT INTO ai_usage (opportunity_id, step, model, input_tokens, output_tokens, ok) VALUES ($1, 'draft', $2, $3, $4, true)`, [
          oppId,
          ai.extractModel,
          r.inputTokens,
          r.outputTokens,
        ]);
      } catch (error) {
        await query(`INSERT INTO ai_usage (opportunity_id, step, model, input_tokens, output_tokens, ok) VALUES ($1, 'draft', $2, $3, $4, false)`, [
          oppId,
          ai.extractModel,
          r.inputTokens,
          r.outputTokens,
        ]);
        if (!(error instanceof InvalidDraftError)) throw error;
        if (attempt === 1) failure = "The AI's draft couldn't be read. Try again.";
      }
    } catch (error) {
      if (error instanceof ClaudeApiError) {
        failure =
          error.accountProblem === "credit"
            ? "The Claude account is out of credit. Add credit at console.anthropic.com → Billing, then try again."
            : error.accountProblem
              ? "Claude refused the request for this account. Check ANTHROPIC_API_KEY and billing."
              : error.isTransient
                ? "Claude is busy or didn't answer in time. Try again in a minute."
                : "Claude couldn't write this reply. Try again, or with different instructions.";
      } else throw error;
    }
  }

  // 3. Store the result, with the checks a person must see before sending.
  if (!answer) {
    await query(`UPDATE drafts SET status = 'failed', error = $2 WHERE id = $1`, [setup.draftId, failure]);
    throw new EditError(failure ?? "The reply couldn't be written. Try again.");
  }
  const a: DraftAnswer = answer;
  const sources = sourcesFor(setup.thread, instructions, context.facts, context.offerLines);
  const warnings = checkDraft(a.body, sources);
  await tx(async (c) => {
    await c.query(
      `UPDATE drafts SET status = 'ready', subject = $2, body = $3, warnings = $4, ai_notes = $5, error = NULL WHERE id = $1`,
      [setup.draftId, a.subject || replySubject(setup.thread.at(-1)?.subject ?? null), a.body, JSON.stringify(warnings), a.notes || null],
    );
    await log(c, oppId, admin, "reply_drafted", { draftId: setup.draftId, mode: MODE_LABEL[mode] });
    await rescoreOpportunity(c, oppId);
  });
  const blocking = warnings.filter((w) => w.kind === "placeholder").length;
  return {
    draftId: setup.draftId,
    message: blocking
      ? `Draft ready. Fill in ${blocking} ${blocking === 1 ? "gap" : "gaps"} marked [like this] before it can go out.`
      : "Draft ready. Read it through, then save it to Gmail or send it.",
  };
}

function sourcesFor(thread: ThreadRow[], instructions: string | null, facts: string, offer: string[]): string {
  return [...thread.map((e) => `${e.subject ?? ""}\n${e.body_text ?? ""}`), instructions ?? "", facts, ...offer].join("\n");
}

// --- Editing and discarding ---------------------------------------------------------------------------------

type DraftRow = {
  id: string;
  opportunity_id: string;
  status: string;
  subject: string | null;
  body: string | null;
  to_email: string | null;
  thread_id: string | null;
  reply_to_email: string | null;
  instructions: string | null;
};

async function lockDraft(c: pg.PoolClient, oppId: string, draftId: unknown, nowait = false): Promise<DraftRow> {
  if (typeof draftId !== "string" || !/^[0-9a-f-]{36}$/i.test(draftId)) throw new EditError("That draft no longer exists.");
  try {
    const r = await c.query<DraftRow>(
      `SELECT id, opportunity_id, status, subject, body, to_email, thread_id, reply_to_email, instructions
       FROM drafts WHERE id = $1 AND opportunity_id = $2 FOR UPDATE${nowait ? " NOWAIT" : ""}`,
      [draftId, oppId],
    );
    if (!r.rows[0]) throw new EditError("That draft no longer exists.");
    return r.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") throw new EditError("This draft is already being saved or sent. Reload in a moment.");
    throw error;
  }
}

export async function saveDraftEdits(admin: AdminSession, oppId: string, form: FormData): Promise<string> {
  const subject = String(form.get("subject") ?? "").replace(/[\r\n]+/g, " ").trim();
  const body = String(form.get("body") ?? "").replace(/\r\n?/g, "\n").trim();
  if (!subject) throw new EditError("The subject can't be empty.");
  if (subject.length > 300) throw new EditError("Keep the subject under 300 characters.");
  if (body.length < 2) throw new EditError("The reply can't be empty.");
  if (body.length > 20_000) throw new EditError("Keep the reply under 20,000 characters.");
  return tx(async (c) => {
    const d = await lockDraft(c, oppId, form.get("draft"));
    if (d.status !== "ready") throw new EditError(d.status === "sent" ? "This reply was already sent." : "Only a ready draft can be edited here.");
    const thread = await loadThread(c, oppId);
    const prefs = await replyPrefs(c);
    const warnings = checkDraft(body, sourcesFor(thread, d.instructions, prefs.facts, []));
    await c.query(`UPDATE drafts SET subject = $2, body = $3, warnings = $4, updated_by = $5 WHERE id = $1`, [d.id, subject, body, JSON.stringify(warnings), admin.userId]);
    await log(c, oppId, admin, "reply_edited", { draftId: d.id });
    const left = placeholdersIn(body).length;
    return left ? `Saved. ${left} ${left === 1 ? "gap is" : "gaps are"} still marked [like this].` : "Saved.";
  });
}

export async function discardDraft(admin: AdminSession, oppId: string, form: FormData): Promise<string> {
  return tx(async (c) => {
    const d = await lockDraft(c, oppId, form.get("draft"));
    if (d.status === "sent") throw new EditError("A sent reply can't be discarded.");
    if (d.status === "discarded") return "Already discarded.";
    await c.query(`UPDATE drafts SET status = 'discarded', updated_by = $2 WHERE id = $1`, [d.id, admin.userId]);
    await log(c, oppId, admin, "reply_discarded", { draftId: d.id });
    return d.status === "saved_to_gmail" ? "Removed from Spotlight. It's still in Gmail's drafts; delete it there if you don't need it." : "Draft discarded.";
  });
}

// --- Gmail: save as draft, or send -------------------------------------------------------------------------------

type Inbox = {
  id: string;
  email: string;
  status: string;
  scopes: string[];
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires_at: Date | null;
};

/** The connected inbox and a working token, if Spotlight may write to it. */
async function inboxForWriting(oppId: string): Promise<{ inbox: Inbox; token: string; baseUrl: string }> {
  const [inbox] = await query<Inbox>(
    `SELECT a.id, a.email, a.status, a.scopes, a.refresh_token_enc, a.access_token_enc, a.access_token_expires_at
     FROM gmail_accounts a JOIN opportunities o ON o.gmail_account_id = a.id WHERE o.id = $1`,
    [oppId],
  );
  if (!inbox || inbox.status !== "connected") throw new EditError("The Gmail inbox isn't connected. Reconnect it in Settings first.");
  if (!canCompose(inbox.scopes)) {
    throw new EditError("Spotlight isn't allowed to save drafts or send from this inbox yet. In Settings → Gmail, choose “Allow replies”.");
  }
  const gmail = readGmailConfig();
  const endpoints = googleEndpoints();
  try {
    const token = await ensureAccessToken(inbox, { tokenKey: gmail.tokenKey, clientId: gmail.clientId, clientSecret: gmail.clientSecret, endpoints });
    return { inbox, token, baseUrl: endpoints.gmail };
  } catch (error) {
    if (error instanceof ReconnectRequiredError) throw new EditError("Google stopped accepting Spotlight's access. Reconnect Gmail in Settings.");
    throw error;
  }
}

async function mimeFor(c: pg.PoolClient, d: DraftRow, from: string): Promise<string> {
  const thread = await loadThread(c, d.opportunity_id);
  const ids = thread.map((e) => e.rfc_message_id).filter((v): v is string => Boolean(v));
  const target = thread.find((e) => e.id === d.reply_to_email) ?? thread.at(-1);
  return buildReplyMime({
    from,
    to: d.to_email!,
    subject: d.subject ?? "Re:",
    body: d.body ?? "",
    inReplyTo: target?.rfc_message_id ?? null,
    references: ids.join(" "),
  });
}

function gmailRefusal(error: unknown): never {
  if (error instanceof GmailApiError) {
    if (error.status === 401 || error.status === 403) {
      throw new EditError("Google refused. Reconnect Gmail in Settings and choose “Allow replies”, then try again. Nothing was sent.");
    }
    throw new EditError("Gmail didn't accept it just now. Nothing was sent; try again in a minute.");
  }
  throw error;
}

function readyToLeave(d: DraftRow) {
  if (d.status === "sent") throw new EditError("This reply was already sent.");
  if (d.status === "saved_to_gmail") throw new EditError("This draft is already in Gmail. Send it from Gmail, or start a new draft.");
  if (d.status !== "ready") throw new EditError("Only a ready draft can go to Gmail.");
  const gaps = placeholdersIn(d.body ?? "");
  if (gaps.length) throw new EditError(`Fill in ${gaps.join(", ")} first, then save.`);
  if (!d.to_email) throw new EditError("This draft has no recipient.");
}

export async function saveToGmail(admin: AdminSession, oppId: string, form: FormData): Promise<string> {
  const { inbox, token, baseUrl } = await inboxForWriting(oppId);
  return tx(async (c) => {
    const d = await lockDraft(c, oppId, form.get("draft"), true);
    readyToLeave(d);
    const raw = await mimeFor(c, d, inbox.email);
    let created;
    try {
      created = await createGmailDraft({ accessToken: token, baseUrl }, raw, d.thread_id);
    } catch (error) {
      gmailRefusal(error);
    }
    await c.query(`UPDATE drafts SET status = 'saved_to_gmail', gmail_draft_id = $2, updated_by = $3 WHERE id = $1`, [d.id, created.id, admin.userId]);
    await log(c, oppId, admin, "reply_saved_to_gmail", { draftId: d.id });
    return "Saved in Gmail's drafts, in the same conversation. Open Gmail to check and send it.";
  });
}

/**
 * Sends the reply from her Gmail. Only after an admin ticks the confirmation; the draft row stays
 * locked during the send so a double click can't send it twice.
 */
export async function sendDraft(admin: AdminSession, oppId: string, form: FormData): Promise<string> {
  if (form.get("confirm") !== "yes") throw new EditError("Tick the box to confirm you've read the reply and want to send it.");
  const { inbox, token, baseUrl } = await inboxForWriting(oppId);
  const web = readWebConfig();
  if (!web.admins.has(admin.email)) throw new EditError("Only an admin can send.");
  return tx(async (c) => {
    const d = await lockDraft(c, oppId, form.get("draft"), true);
    readyToLeave(d);
    const raw = await mimeFor(c, d, inbox.email);
    let sent;
    try {
      sent = await sendGmailMessage({ accessToken: token, baseUrl }, raw, d.thread_id);
    } catch (error) {
      gmailRefusal(error);
    }
    await c.query(
      `UPDATE drafts SET status = 'sent', approved_by = $2, approved_by_email = $3, approved_at = now(), sent_at = now(),
              gmail_sent_message_id = $4, updated_by = $2
       WHERE id = $1`,
      [d.id, admin.userId, admin.email, sent.id],
    );
    await log(c, oppId, admin, "reply_sent", { draftId: d.id, to: d.to_email, subject: d.subject });
    const o = await c.query<{ status: string }>(`SELECT status FROM opportunities WHERE id = $1 FOR UPDATE`, [oppId]);
    const before = o.rows[0]?.status;
    if (before && OUR_TURN.includes(before)) {
      await c.query(`UPDATE opportunities SET status = 'awaiting_their_response', last_activity_at = now() WHERE id = $1`, [oppId]);
      await log(c, oppId, admin, "status_changed", { from: before, to: "awaiting_their_response", because: "Reply sent" });
    }
    await rescoreOpportunity(c, oppId);
    return `Sent to ${d.to_email} from ${inbox.email}. It's in Gmail's Sent folder, in the same conversation.`;
  });
}

// --- For the page ------------------------------------------------------------------------------------------------

export type DraftView = {
  id: string;
  mode: DraftMode;
  tone: Tone;
  status: string;
  subject: string | null;
  body: string | null;
  to_email: string | null;
  instructions: string | null;
  warnings: DraftWarning[];
  ai_notes: string | null;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
  created_by_name: string | null;
  approved_by_email: string | null;
};

export async function listDrafts(oppId: string): Promise<{ drafts: DraftView[]; canWrite: boolean; inboxEmail: string | null; aiOn: boolean }> {
  const [drafts, inbox] = await Promise.all([
    query<DraftView>(
      `SELECT d.id, d.mode, d.tone, d.status, d.subject, d.body, d.to_email, d.instructions, d.warnings, d.ai_notes, d.error,
              d.created_at, d.sent_at, COALESCE(u.name, u.email) AS created_by_name, d.approved_by_email
       FROM drafts d LEFT JOIN users u ON u.id = d.created_by
       WHERE d.opportunity_id = $1 AND d.status <> 'discarded'
       ORDER BY d.created_at DESC LIMIT 5`,
      [oppId],
    ),
    query<{ email: string; status: string; scopes: string[] }>(
      `SELECT a.email, a.status, a.scopes FROM gmail_accounts a JOIN opportunities o ON o.gmail_account_id = a.id WHERE o.id = $1`,
      [oppId],
    ),
  ]);
  const i = inbox[0];
  return {
    drafts,
    canWrite: Boolean(i && i.status === "connected" && canCompose(i.scopes)),
    inboxEmail: i?.email ?? null,
    aiOn: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  };
}

export async function saveReplyPrefs(admin: AdminSession, form: FormData): Promise<string> {
  const clean = (k: string, max: number) => {
    const v = String(form.get(k) ?? "").replace(/\r\n?/g, "\n").trim();
    if (v.length > max) throw new EditError(`Keep it under ${max} characters.`);
    return v;
  };
  const signature = clean("signature", 300);
  const facts = clean("facts", 1500);
  await query(
    `INSERT INTO preferences (key, value, updated_by) VALUES ('reply_signature', $1, $3), ('reply_facts', $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(signature), JSON.stringify(facts), admin.userId],
  );
  return "Saved. New drafts use this signature and these facts.";
}

export async function getReplyPrefs(): Promise<{ signature: string; facts: string }> {
  return replyPrefs(getPool());
}
