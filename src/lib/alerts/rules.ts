// Which alerts to send, decided by plain code from what is stored, never by the model.
// Every alert has a key; the database keeps one notification per key, person and channel,
// so running these rules every minute never repeats an alert.
import { formatDay, relativeDay } from "../format.ts";

export type AlertKind =
  | "new_offer"
  | "reply_due"
  | "event_soon"
  | "date_soon"
  | "their_email"
  | "terms_changed"
  | "cancelled"
  | "nudge_reply"
  | "nudge_follow_up"
  | "snooze_ended"
  | "flag"
  | "her_answer"
  | "reminder"
  | "gmail_reconnect"
  | "test";

/** A tap-to-answer button on a Telegram message. */
export type AlertAction = { label: string; data: string };

export type AlertEvent = {
  key: string;
  kind: AlertKind;
  opportunityId: string | null;
  title: string;
  body: string;
  /** Path inside Spotlight that the alert opens. */
  url: string;
  audience: "everyone" | "talent" | "team" | { userId: string };
  /** Urgent alerts ignore quiet hours. */
  urgent: boolean;
  /** For new offers: only high-priority ones reach people who chose "high priority only". */
  priority?: string;
  actions: AlertAction[];
};

export type AlertTypes = { newOffers: "high" | "all" | "off"; deadlines: boolean; changes: boolean; nudges: boolean };
export const DEFAULT_ALERT_TYPES: AlertTypes = { newOffers: "high", deadlines: true, changes: true, nudges: true };

export function parseAlertTypes(raw: unknown): AlertTypes {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    newOffers: o.new_offers === "all" || o.new_offers === "off" || o.new_offers === "high" ? o.new_offers : "high",
    deadlines: flag(o.deadlines, true),
    changes: flag(o.changes, true),
    nudges: flag(o.nudges, true),
  };
}

export type Recipient = { userId: string; isTalent: boolean; types: AlertTypes };

/** Whether this person should get this alert, by who it's for and what they chose to hear about. */
export function wantsAlert(r: Recipient, e: AlertEvent): boolean {
  const a = e.audience;
  if (a === "talent" && !r.isTalent) return false;
  if (a === "team" && r.isTalent) return false;
  if (typeof a === "object" && a.userId !== r.userId) return false;
  switch (e.kind) {
    case "new_offer":
      return r.types.newOffers === "all" || (r.types.newOffers === "high" && e.priority === "high");
    case "reply_due":
    case "event_soon":
    case "date_soon":
      return r.types.deadlines;
    case "their_email":
    case "terms_changed":
    case "cancelled":
      return r.types.changes;
    case "nudge_reply":
    case "nudge_follow_up":
    case "snooze_ended":
      return r.types.nudges;
    default:
      return true; // flags, her answers, reminders, inbox problems and tests always go out
  }
}

// --- Quiet hours ---------------------------------------------------------------------------------------

const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/**
 * If `now` is inside the person's quiet hours, when they end; otherwise null.
 * Windows may cross midnight (23:00 to 08:00). Equal or missing start and end mean no quiet hours.
 */
export function quietHoursEnd(now: Date, start: string | null, end: string | null, timeZone = "Asia/Kolkata"): Date | null {
  const s = start ? minutesOf(start) : null;
  const e = end ? minutesOf(end) : null;
  if (s === null || e === null || s === e) return null;
  let local: number;
  try {
    local = localMinutes(now, timeZone);
  } catch {
    local = localMinutes(now, "Asia/Kolkata");
  }
  const inside = s < e ? local >= s && local < e : local >= s || local < e;
  if (!inside) return null;
  const wait = (e - local + 1440) % 1440;
  const at = new Date(now.getTime() + wait * 60_000);
  at.setUTCSeconds(0, 0);
  return at;
}

// --- Opportunity rules -------------------------------------------------------------------------------------

export type OpportunityState = {
  id: string;
  title: string;
  organization: string | null;
  priority: string;
  status: string;
  isIrrelevant: boolean;
  fromHistorical: boolean;
  createdAt: Date;
  snoozedUntil: Date | null;
  replyByAt: Date | null;
  eventStartAt: Date | null;
  nextDeadlineAt: Date | null;
  /** Latest email or admin action on it. */
  lastTouchAt: Date;
  pay: string;
  redFlagCount: number;
  flaggedAt: Date | null;
  flagNote: string | null;
  flaggedByName: string | null;
  talentResponse: "interested" | "pass" | "questions" | null;
  talentResponseNote: string | null;
  talentRespondedAt: Date | null;
};

export const CLOSED_STATUSES = ["declined", "completed", "expired", "archived"];
const SETTLED = ["confirmed", "accepted"];
const OUR_TURN = ["new", "reviewed", "interested", "needs_information", "awaiting_my_response", "reply_drafted"];
const GOING_AHEAD = ["interested", "in_negotiation", "awaiting_their_response", "awaiting_my_response", "confirmed", "accepted"];

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Things that happened longer ago than this aren't announced (for example right after an outage or first deploy). */
export const RECENT_MS = 6 * HOUR;

export const RESPONSE_LABEL = { interested: "Interested", pass: "Pass", questions: "Has questions" } as const;

const iso = (d: Date) => d.toISOString();
const within = (d: Date | null, now: Date, ms: number) => d !== null && d.getTime() > now.getTime() && d.getTime() <= now.getTime() + ms;
const recent = (d: Date | null, now: Date) => d !== null && d.getTime() <= now.getTime() && now.getTime() - d.getTime() <= RECENT_MS;
const who = (o: OpportunityState) => (o.organization ? ` · ${o.organization}` : "");
const shortTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const when = (d: Date, now: Date) => {
  const rel = relativeDay(d, now);
  return `${rel === "today" || rel === "tomorrow" ? rel : formatDay(d)}, ${shortTime.format(d)}`;
};

export function opportunityAlerts(o: OpportunityState, now: Date): AlertEvent[] {
  if (o.isIrrelevant || CLOSED_STATUSES.includes(o.status)) return [];
  const url = `/opportunities/${o.id}`;
  const base = { opportunityId: o.id, url, urgent: false, actions: [] as AlertAction[] };
  const out: AlertEvent[] = [];

  // Her answer to the team, and the question to her, go out even while snoozed.
  if (o.talentResponse && o.talentRespondedAt && recent(o.talentRespondedAt, now)) {
    out.push({
      ...base,
      key: `her_answer:${o.id}:${iso(o.talentRespondedAt)}`,
      kind: "her_answer",
      title: `She said: ${RESPONSE_LABEL[o.talentResponse]}`,
      body: `${o.title}${who(o)}${o.talentResponseNote ? `\n“${o.talentResponseNote}”` : ""}`,
      audience: "team",
    });
  }
  if (o.flaggedAt && !o.talentResponse && now.getTime() - o.flaggedAt.getTime() <= 7 * DAY && o.flaggedAt.getTime() <= now.getTime()) {
    const lines = [`${o.title}${who(o)}`, `Pay: ${o.pay}`];
    if (o.nextDeadlineAt && o.nextDeadlineAt.getTime() > now.getTime()) lines.push(`Next date: ${when(o.nextDeadlineAt, now)}`);
    if (o.redFlagCount > 0) lines.push("Has warning signs: check before saying yes.");
    if (o.flagNote) lines.push(`${o.flaggedByName ?? "Your manager"}: “${o.flagNote}”`);
    out.push({
      ...base,
      key: `flag:${o.id}:${iso(o.flaggedAt)}`,
      kind: "flag",
      title: "Your call: are you interested?",
      body: lines.join("\n"),
      audience: "talent",
      actions: [
        { label: "Interested", data: answerData(o.id, "interested") },
        { label: "Pass", data: answerData(o.id, "pass") },
        { label: "Questions", data: answerData(o.id, "questions") },
      ],
    });
  }

  if (o.snoozedUntil && o.snoozedUntil.getTime() > now.getTime()) return out;
  if (o.snoozedUntil && recent(o.snoozedUntil, now)) {
    out.push({ ...base, key: `snooze_ended:${o.id}:${iso(o.snoozedUntil)}`, kind: "snooze_ended", title: "Back from snooze", body: `${o.title}${who(o)}`, audience: "everyone" });
  }

  if (!o.fromHistorical && recent(o.createdAt, now)) {
    const label = o.priority === "high" ? "New high-priority offer" : o.priority === "needs_review" ? "New possible offer to check" : "New offer";
    out.push({
      ...base,
      key: `new_offer:${o.id}`,
      kind: "new_offer",
      title: label,
      body: `${o.title}${who(o)}\nPay: ${o.pay}${o.redFlagCount > 0 ? "\nHas warning signs." : ""}`,
      audience: "everyone",
      priority: o.priority,
    });
  }

  if (!SETTLED.includes(o.status) && o.replyByAt && within(o.replyByAt, now, DAY)) {
    const soon = within(o.replyByAt, now, 3 * HOUR);
    out.push({
      ...base,
      key: `${soon ? "reply_due_soon" : "reply_due"}:${o.id}:${iso(o.replyByAt)}`,
      kind: "reply_due",
      title: soon ? "Reply due in under 3 hours" : "Reply due within a day",
      body: `${o.title}${who(o)}\nReply by ${when(o.replyByAt, now)}`,
      audience: "everyone",
      urgent: soon,
    });
  }
  if (GOING_AHEAD.includes(o.status) && o.eventStartAt && within(o.eventStartAt, now, DAY)) {
    out.push({
      ...base,
      key: `event_soon:${o.id}:${iso(o.eventStartAt)}`,
      kind: "event_soon",
      title: "Coming up within a day",
      body: `${o.title}${who(o)}\nStarts ${when(o.eventStartAt, now)}`,
      audience: "everyone",
    });
  }
  const otherDate =
    o.nextDeadlineAt &&
    o.nextDeadlineAt.getTime() !== o.replyByAt?.getTime() &&
    o.nextDeadlineAt.getTime() !== o.eventStartAt?.getTime() &&
    within(o.nextDeadlineAt, now, DAY);
  if (otherDate && !SETTLED.includes(o.status) && o.nextDeadlineAt) {
    out.push({
      ...base,
      key: `date_soon:${o.id}:${iso(o.nextDeadlineAt)}`,
      kind: "date_soon",
      title: "A date is coming up within a day",
      body: `${o.title}${who(o)}\n${when(o.nextDeadlineAt, now)}`,
      audience: "everyone",
    });
  }

  // Gentle nudges, at most every few days, and not forever.
  const idle = now.getTime() - o.lastTouchAt.getTime();
  if (!o.fromHistorical && OUR_TURN.includes(o.status) && (o.priority === "high" || o.priority === "medium") && idle >= 2 * DAY) {
    const round = Math.floor((idle - 2 * DAY) / (3 * DAY));
    if (round < 4) {
      out.push({
        ...base,
        key: `nudge_reply:${o.id}:${iso(o.lastTouchAt)}:${round}`,
        kind: "nudge_reply",
        title: "Still waiting on us",
        body: `${o.title}${who(o)}\nNo reply or update for ${Math.floor(idle / DAY)} days.`,
        audience: "everyone",
      });
    }
  }
  if (o.status === "awaiting_their_response" && idle >= 5 * DAY) {
    const round = Math.floor((idle - 5 * DAY) / (5 * DAY));
    if (round < 3) {
      out.push({
        ...base,
        key: `nudge_follow_up:${o.id}:${iso(o.lastTouchAt)}:${round}`,
        kind: "nudge_follow_up",
        title: "No answer from them yet. Follow up?",
        body: `${o.title}${who(o)}\nWaiting ${Math.floor(idle / DAY)} days for their reply.`,
        audience: "everyone",
      });
    }
  }
  return out;
}

// --- Their emails on an existing offer -------------------------------------------------------------------------

export type EmailActivity = {
  kind: "email_received" | "change_detected" | "cancellation_detected";
  emailId: string;
  field?: string;
  from?: string;
  to?: string;
};

export type OpportunityRef = { id: string; title: string; organization: string | null; isIrrelevant: boolean; status: string };

const FIELD_LABEL: Record<string, string> = {
  compensation: "Pay",
  dates: "Date",
  location: "Location",
  usage_rights: "Usage rights",
  exclusivity: "Exclusivity",
  expenses_covered: "Expenses",
  deliverables: "Deliverables",
};

/** One alert per email, however many things it changed. */
export function emailAlerts(o: OpportunityRef, activities: EmailActivity[]): AlertEvent[] {
  if (o.isIrrelevant || CLOSED_STATUSES.includes(o.status)) return [];
  const byEmail = new Map<string, EmailActivity[]>();
  for (const a of activities) byEmail.set(a.emailId, [...(byEmail.get(a.emailId) ?? []), a]);
  const out: AlertEvent[] = [];
  for (const [emailId, list] of byEmail) {
    const changes = list.filter((a) => a.kind === "change_detected");
    const cancelled = list.some((a) => a.kind === "cancellation_detected");
    const kind: AlertKind = cancelled ? "cancelled" : changes.length ? "terms_changed" : "their_email";
    const lines = [`${o.title}${o.organization ? ` · ${o.organization}` : ""}`];
    for (const c of changes.slice(0, 4)) {
      lines.push(`${FIELD_LABEL[c.field ?? ""] ?? (c.field ?? "Detail").replace(/_/g, " ")}: ${c.from || "not stated"} → ${c.to || "not stated"}`);
    }
    out.push({
      key: `email:${emailId}:${o.id}`,
      kind,
      opportunityId: o.id,
      title: cancelled ? "They cancelled or withdrew" : changes.length ? "They changed the terms" : "They wrote back",
      body: lines.join("\n"),
      url: `/opportunities/${o.id}`,
      audience: "everyone",
      urgent: false,
      actions: [],
    });
  }
  return out;
}

// --- Buttons ----------------------------------------------------------------------------------------------------------

export type Answer = "interested" | "pass" | "questions";
const ANSWER_CODE: Record<Answer, string> = { interested: "i", pass: "p", questions: "q" };

/** Button data carried by Telegram (at most 64 bytes): which offer and which answer. */
export function answerData(oppId: string, answer: Answer): string {
  return `a:${oppId}:${ANSWER_CODE[answer]}`;
}

export function parseAnswerData(data: unknown): { oppId: string; answer: Answer } | null {
  if (typeof data !== "string") return null;
  const m = /^a:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([ipq])$/.exec(data);
  if (!m) return null;
  const answer = (Object.keys(ANSWER_CODE) as Answer[]).find((k) => ANSWER_CODE[k] === m[2])!;
  return { oppId: m[1]!, answer };
}
