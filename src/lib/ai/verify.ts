// Checks the AI's extraction against the email itself. A value whose quote can't be found in
// the email is kept but marked unverified; nothing is ever filled in that the email doesn't say.
import type { DateKind, ExtractionAnswer } from "./schemas.ts";

const IST_OFFSET_MS = 5.5 * 3600_000;

export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‛`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote (allowing "…" gaps) appears in the source text, ignoring case, spacing and quote styles. */
export function quoteFound(quote: string, normalizedSource: string): boolean {
  const q = normalizeForMatch(quote).replace(/^["'.… ]+|["'.… ]+$/g, "");
  if (q.length < 2) return false;
  const parts = q
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  let from = 0;
  for (const part of parts) {
    const at = normalizedSource.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return parts.length > 0;
}

/** True when the quote plausibly states this amount: its digits appear, or it uses k / lakh / crore wording. */
export function amountSupportedByQuote(amount: number, quote: string): boolean {
  if (!quote || !(amount > 0)) return false;
  const digits = quote.replace(/[^\d]/g, "");
  if (digits.includes(String(Math.round(amount)))) return true;
  return /\d\s*(k|l|lakhs?|lacs?|cr|crores?|thousand|mn|million)\b/i.test(quote) || /\b(lakhs?|lacs?|crores?|thousand)\b/i.test(quote);
}

/** An India-time calendar date (and optional HH:MM) as an exact instant. Null if invalid. */
export function parseDateIST(date: string, time: string, defaultTime: "23:59" | "00:00"): Date | null {
  const d = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d) return null;
  const t = (time.trim() || defaultTime).match(/^(\d{1,2}):(\d{2})$/);
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hh, mm] = t ? [Number(t[1]), Number(t[2])] : defaultTime === "23:59" ? [23, 59] : [0, 0];
  if (m < 1 || m > 12 || day < 1 || day > 31 || hh > 23 || mm > 59 || y < 2000 || y > 2100) return null;
  const utc = Date.UTC(y, m - 1, day, hh, mm) - IST_OFFSET_MS;
  const check = new Date(utc + IST_OFFSET_MS);
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) return null; // e.g. 31 Feb
  return new Date(utc);
}

export type Checked<T> = T & { verified: boolean };
export type CheckedDate = { kind: DateKind; at: Date | null; text: string; quote: string; verified: boolean };

export type VerifiedExtraction = {
  title: string;
  summary: string;
  category: string;
  text: Record<TextField, Checked<{ value: string; quote: string }>>;
  deliverables: Array<Checked<{ item: string; quote: string }>>;
  compensation: {
    type: ExtractionAnswer["compensation"]["type"];
    status: ExtractionAnswer["compensation"]["status"];
    amountMin: number | null;
    amountMax: number | null;
    currency: string;
    text: string;
    quote: string;
    verified: boolean;
  };
  format: ExtractionAnswer["format"];
  dates: CheckedDate[];
  isNegotiable: boolean | null;
  missingInformation: string[];
  aiRedFlags: Array<{ flag: string; quote: string }>;
  cancellation: boolean;
  unverified: string[];
  replyBy: Date | null;
  eventStart: Date | null;
  eventEnd: Date | null;
  nextDeadline: Date | null;
  latestPastDeadline: Date | null;
};

export const TEXT_FIELDS = [
  "organization",
  "sender_role",
  "contact_phone",
  "offer",
  "usage_rights",
  "exclusivity",
  "expenses_covered",
  "location",
  "requested_action",
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

const DEADLINE_KINDS: ReadonlySet<DateKind> = new Set(["reply_by", "deadline", "audition", "shoot", "event_start"]);

export function verifyExtraction(
  raw: ExtractionAnswer,
  email: { fromName: string | null; fromEmail: string | null; subject: string | null; bodyText: string },
  now: Date = new Date(),
): VerifiedExtraction {
  const source = normalizeForMatch(
    [`${email.fromName ?? ""} <${email.fromEmail ?? ""}>`, email.subject ?? "", email.bodyText].join("\n"),
  );
  const unverified: string[] = [];
  const clean = (s: string) => s.trim().replace(/\s+/g, " ");

  const text = {} as VerifiedExtraction["text"];
  for (const field of TEXT_FIELDS) {
    const value = clean(raw[field].value);
    const quote = raw[field].quote.trim();
    // "offer" is a summary in the AI's own words, so its quote is what gets checked.
    const verified = value.length > 0 && quoteFound(quote, source);
    if (value && !verified) unverified.push(field);
    text[field] = { value, quote: value ? quote : "", verified };
  }

  const deliverables = raw.deliverables
    .map((d) => ({ item: clean(d.item), quote: d.quote.trim() }))
    .filter((d) => d.item.length > 0)
    .map((d) => ({ ...d, verified: quoteFound(d.quote, source) }));
  if (deliverables.some((d) => !d.verified)) unverified.push("deliverables");

  // Compensation: amounts only when the status says one was stated, never negative, min <= max.
  const c = raw.compensation;
  const stated = c.status === "confirmed" || c.status === "range";
  let amountMin = stated && c.amount_min > 0 ? c.amount_min : null;
  let amountMax = stated && c.amount_max > 0 ? c.amount_max : amountMin;
  if (amountMin === null && amountMax !== null) amountMin = amountMax;
  if (amountMin !== null && amountMax !== null && amountMax < amountMin) [amountMin, amountMax] = [amountMax, amountMin];
  const currency = /^[A-Za-z]{3}$/.test(c.currency.trim()) ? c.currency.trim().toUpperCase() : "INR";
  const quoteOk = quoteFound(c.quote, source);
  const amountsOk =
    amountMin === null || (amountSupportedByQuote(amountMin, c.quote) && amountSupportedByQuote(amountMax ?? amountMin, c.quote));
  const compVerified = c.status === "not_disclosed" ? true : quoteOk && amountsOk;
  if (!compVerified) unverified.push("compensation");

  const dates: CheckedDate[] = raw.dates
    .filter((d) => d.date.trim() || d.text.trim())
    .map((d) => {
      const at = parseDateIST(d.date, d.time, d.kind === "event_start" || d.kind === "shoot" || d.kind === "audition" ? "00:00" : "23:59");
      const verified = at !== null && quoteFound(d.quote, source);
      return { kind: d.kind, at, text: clean(d.text), quote: d.quote.trim(), verified };
    });
  if (dates.some((d) => d.at && !d.verified)) unverified.push("dates");

  const first = (kind: DateKind) => dates.find((d) => d.kind === kind && d.at)?.at ?? null;
  const deadlineDates = dates
    .filter((d) => d.at && DEADLINE_KINDS.has(d.kind))
    .map((d) => d.at!)
    .sort((a, b) => a.getTime() - b.getTime());
  const future = deadlineDates.filter((d) => d.getTime() >= now.getTime());
  const past = deadlineDates.filter((d) => d.getTime() < now.getTime());

  const aiRedFlags = raw.red_flags
    .map((f) => ({ flag: clean(f.flag), quote: f.quote.trim() }))
    .filter((f) => f.flag && quoteFound(f.quote, source)); // a warning must point at real words

  const eventStart = first("event_start") ?? first("shoot") ?? first("audition");
  let eventEnd = first("event_end");
  if (eventStart && eventEnd && eventEnd.getTime() < eventStart.getTime()) eventEnd = null; // impossible order: drop the end

  return {
    title: clean(raw.title).slice(0, 120) || clean(email.subject ?? "").slice(0, 120) || "Untitled opportunity",
    summary: clean(raw.summary),
    category: raw.category,
    text,
    deliverables,
    compensation: {
      type: c.type,
      status: c.status,
      amountMin,
      amountMax,
      currency,
      text: clean(c.text),
      quote: c.quote.trim(),
      verified: compVerified,
    },
    format: raw.format,
    dates,
    isNegotiable: raw.is_negotiable === "yes" ? true : raw.is_negotiable === "no" ? false : null,
    missingInformation: [...new Set(raw.missing_information.map(clean).filter(Boolean))],
    aiRedFlags,
    cancellation: raw.cancellation === true,
    unverified,
    replyBy: first("reply_by") ?? first("deadline"),
    eventStart,
    eventEnd,
    nextDeadline: future[0] ?? null,
    latestPastDeadline: past.at(-1) ?? null,
  };
}
