// Recomputes an offer's credibility checklist from what's stored and saves it on the offer.
// Runs after the AI touches an offer and at the end of every admin change (via rescoreOpportunity).
import type pg from "pg";
import { assessCredibility, senderKey, type AuthResult, type CredEmail } from "./credibility.ts";
import { domainOf } from "./redflags.ts";

type Runner = Pick<pg.PoolClient, "query">;

const stringList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function senderLists(c: Runner): Promise<{ trusted: string[]; blocked: string[] }> {
  const { rows } = await c.query<{ key: string; value: unknown }>(`SELECT key, value FROM preferences WHERE key IN ('trusted_senders', 'blocked_senders')`);
  const get = (k: string) => stringList(rows.find((r) => r.key === k)?.value);
  return { trusted: get("trusted_senders"), blocked: get("blocked_senders") };
}

/** Must run inside the caller's transaction (pass its client). */
export async function refreshCredibility(c: Runner, oppId: string): Promise<void> {
  const o = (
    await c.query<{
      organization: string | null;
      sender_email: string | null;
      compensation_status: string;
      deliverables: unknown[];
      reply_by_at: Date | null;
      event_start_at: Date | null;
      location: string | null;
      sender_role: string | null;
      contact_phone: string | null;
      inbox: string;
    }>(
      `SELECT o.organization, o.sender_email, o.compensation_status, o.deliverables, o.reply_by_at, o.event_start_at, o.location,
              o.sender_role, o.contact_phone, a.email AS inbox
       FROM opportunities o JOIN gmail_accounts a ON a.id = o.gmail_account_id WHERE o.id = $1`,
      [oppId],
    )
  ).rows[0];
  if (!o) return;

  const emails = (
    await c.query<{
      from_email: string | null;
      from_name: string | null;
      reply_to: string | null;
      to_emails: string[];
      cc_emails: string[];
      subject: string | null;
      body_text: string | null;
      gmail_labels: string[];
      auth: AuthResult | null;
      is_bulk: boolean;
    }>(
      `SELECT e.from_email, e.from_name, e.reply_to, e.to_emails, e.cc_emails, e.subject, e.body_text, e.gmail_labels, e.auth, e.is_bulk
       FROM opportunity_emails oe JOIN emails e ON e.id = oe.email_id
       WHERE oe.opportunity_id = $1 AND lower(COALESCE(e.from_email, '')) <> lower($2)
       ORDER BY e.received_at`,
      [oppId, o.inbox],
    )
  ).rows.map(
    (e): CredEmail => ({
      fromEmail: e.from_email,
      fromName: e.from_name,
      replyTo: e.reply_to,
      to: e.to_emails,
      cc: e.cc_emails,
      subject: e.subject,
      body: e.body_text ?? "",
      labels: e.gmail_labels,
      auth: e.auth,
      bulk: e.is_bulk,
    }),
  );

  // Her names, to see whether an email greets her personally.
  const talent = (
    await c.query<{ name: string | null; names: unknown }>(
      `SELECT u.name, (SELECT value FROM preferences WHERE key = 'talent_names') AS names
       FROM preferences p LEFT JOIN users u ON u.email = p.value #>> '{}'
       WHERE p.key = 'talent_email'`,
    )
  ).rows[0];
  const talentNames = [...stringList(talent?.names)];
  if (talent?.name) talentNames.push(talent.name, talent.name.split(/\s+/)[0]!);

  // Earlier dealings with the same sender: deals that went ahead, or replies we sent them.
  const sender = emails[0]?.fromEmail ?? o.sender_email;
  const key = senderKey(sender);
  const domain = domainOf(sender);
  let pastDeals = 0;
  let repliedBefore = false;
  if (key && domain) {
    const byDomain = key.startsWith("domain:");
    const match = byDomain ? `split_part(lower(%s), '@', 2) = $2` : `lower(%s) = $2`;
    const value = byDomain ? domain : sender!.toLowerCase();
    const h = await c.query<{ deals: string; replied: boolean }>(
      `SELECT (SELECT count(*) FROM opportunities o2
               WHERE o2.id <> $1 AND o2.status IN ('accepted', 'confirmed', 'completed') AND ${match.replace("%s", "o2.sender_email")}) AS deals,
              EXISTS (SELECT 1 FROM drafts d WHERE d.opportunity_id <> $1 AND d.status = 'sent' AND ${match.replace("%s", "d.to_email")}) AS replied`,
      [oppId, value],
    );
    pastDeals = Number(h.rows[0]?.deals ?? 0);
    repliedBefore = Boolean(h.rows[0]?.replied);
  }
  const lists = await senderLists(c);

  const result = assessCredibility({
    inbox: o.inbox,
    talentNames,
    organization: o.organization,
    emails,
    facts: {
      fee: o.compensation_status === "confirmed" || o.compensation_status === "range",
      deliverables: Array.isArray(o.deliverables) && o.deliverables.length > 0,
      date: Boolean(o.reply_by_at || o.event_start_at),
      location: Boolean(o.location),
      role: o.sender_role,
      phone: Boolean(o.contact_phone),
    },
    history: { pastDeals, repliedBefore },
    trusted: !!key && lists.trusted.includes(key),
  });
  await c.query(`UPDATE opportunities SET credibility = $2 WHERE id = $1`, [oppId, JSON.stringify(result)]);
}
