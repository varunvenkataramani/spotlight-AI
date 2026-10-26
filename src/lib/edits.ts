// Parses what an admin types into the dashboard: amounts written the Indian way, dates,
// statuses and list filters. Pure, so every rule is unit-tested; anything unclear is refused
// with a plain message instead of being guessed.

export const STATUSES = [
  "new",
  "reviewed",
  "interested",
  "needs_information",
  "reply_drafted",
  "awaiting_my_response",
  "awaiting_their_response",
  "in_negotiation",
  "confirmed",
  "accepted",
  "declined",
  "completed",
  "expired",
  "archived",
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  new: "New",
  reviewed: "Reviewed",
  interested: "Interested",
  needs_information: "Needs more information",
  reply_drafted: "Reply drafted",
  awaiting_my_response: "Our turn to reply",
  awaiting_their_response: "Waiting on them",
  in_negotiation: "Negotiating",
  confirmed: "Confirmed",
  accepted: "Accepted",
  declined: "Declined",
  completed: "Completed",
  expired: "Expired",
  archived: "Archived",
};

/** Stages for the board, left to right. Every status belongs to exactly one. */
export const STAGES = [
  { key: "new", label: "New", statuses: ["new", "reviewed"] },
  { key: "considering", label: "Considering", statuses: ["interested", "needs_information"] },
  { key: "talking", label: "In conversation", statuses: ["reply_drafted", "awaiting_my_response", "awaiting_their_response", "in_negotiation"] },
  { key: "confirmed", label: "Confirmed", statuses: ["confirmed", "accepted"] },
  { key: "done", label: "Closed", statuses: ["completed", "declined", "expired", "archived"] },
] as const satisfies ReadonlyArray<{ key: string; label: string; statuses: readonly Status[] }>;

export class EditError extends Error {}

export function parseStatus(raw: unknown): Status {
  if (typeof raw === "string" && (STATUSES as readonly string[]).includes(raw)) return raw as Status;
  throw new EditError("Choose one of the listed statuses.");
}

/**
 * "75,000" → 75000 · "₹1,50,000" → 150000 · "1.5 lakh" → 150000 · "75k" → 75000 · "2 cr" → 20000000.
 * Empty means "not stated" (null). Anything else is refused rather than guessed.
 */
export function parseAmount(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim().toLowerCase().replace(/^(?:rs\.?|inr|₹|\$|usd|eur|€|£)\s*/, "").replace(/\s*\/-$/, "");
  if (text === "") return null;
  const m = text.match(/^(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|l|lakh|lakhs|lac|lacs|cr|crore|crores|m|mn|million)?$/);
  if (!m) throw new EditError(`"${String(raw).trim()}" isn't an amount. Use digits, like 75,000 or 1.5 lakh.`);
  const base = Number(m[1]!.replace(/,/g, ""));
  const unit = m[2] ?? "";
  const multiplier = /^(k|thousand)$/.test(unit)
    ? 1_000
    : /^(l|lakhs?|lacs?)$/.test(unit)
      ? 100_000
      : /^(cr|crores?)$/.test(unit)
        ? 10_000_000
        : /^(m|mn|million)$/.test(unit)
          ? 1_000_000
          : 1;
  const value = Math.round(base * multiplier);
  if (!Number.isFinite(value) || value < 0 || value > 1e12) throw new EditError("That amount is out of range.");
  return value;
}

export function parseCurrency(raw: unknown): string {
  const c = String(raw ?? "").trim().toUpperCase() || "INR";
  if (!/^[A-Z]{3}$/.test(c)) throw new EditError("Currency must be a three-letter code such as INR or USD.");
  return c;
}

const IST_OFFSET_MS = 5.5 * 3600_000;

/** A date typed in a date field (YYYY-MM-DD), as the end of that day in India time, or null when cleared. */
export function parseDayIST(raw: unknown, endOfDay = true): Date | null {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new EditError("Pick a date from the calendar.");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0) - IST_OFFSET_MS;
  const check = new Date(utc + IST_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new EditError("That date doesn't exist.");
  }
  return new Date(utc);
}

/** A reminder time: a calendar day and a clock time (HH:MM) in India time, which must be ahead of now and within a year. */
export function parseReminderTime(rawDay: unknown, rawTime: unknown, now: Date = new Date()): Date {
  const day = parseDayIST(rawDay, false);
  if (!day) throw new EditError("Pick a day for the reminder.");
  const m = String(rawTime ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new EditError("Pick a time for the reminder.");
  const at = new Date(day.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60_000);
  if (at.getTime() <= now.getTime() + 60_000) throw new EditError("Pick a time later than now.");
  if (at.getTime() > now.getTime() + 366 * 86_400_000) throw new EditError("Reminders can be up to a year ahead.");
  return at;
}

/** Quiet hours as typed in a time field (HH:MM). */
export function parseClock(raw: unknown): string {
  const m = String(raw ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::00)?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new EditError("Pick a time like 23:00.");
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** The India-time calendar day of an instant, for a date field's value. */
export function dayValueIST(d: Date | null): string {
  return d ? new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) : "";
}

export function cleanText(raw: unknown, max = 500): string | null {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length > max) throw new EditError(`Keep it under ${max} characters.`);
  return text === "" ? null : text;
}

/** A note keeps its line breaks; it must say something and stay a reasonable length. */
export function parseNote(raw: unknown): string {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new EditError("Write something in the note first.");
  if (text.length > 4000) throw new EditError("Keep notes under 4,000 characters.");
  return text;
}

export function parseLines(raw: unknown, maxItems = 20): string[] {
  const items = String(raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-•*]\s*|\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (items.length > maxItems) throw new EditError(`Up to ${maxItems} items, one per line.`);
  if (items.some((i) => i.length > 200)) throw new EditError("Keep each item under 200 characters.");
  return items;
}

// --- List filters ------------------------------------------------------------------------------

export type ListFilters = {
  view: "list" | "board";
  show: "active" | "waiting" | "closed" | "all";
  category: string | null;
  priority: "high" | "medium" | "low" | "needs_review" | null;
  q: string;
  sort: "urgent" | "newest" | "pay";
};

export const DEFAULT_FILTERS: ListFilters = { view: "list", show: "active", category: null, priority: null, q: "", sort: "urgent" };

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

const PRIORITIES = ["high", "medium", "low", "needs_review"] as const;

/** Unknown or malformed values fall back to defaults; a filter can never break the page. */
export function parseFilters(params: Record<string, string | string[] | undefined>): ListFilters {
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const category = one("category");
  const priority = one("priority");
  return {
    view: pick(one("view"), ["list", "board"] as const, "list"),
    show: pick(one("show"), ["active", "waiting", "closed", "all"] as const, "active"),
    category: category && /^[a-z0-9_]{1,60}$/.test(category) ? category : null,
    priority: PRIORITIES.includes(priority as (typeof PRIORITIES)[number]) ? (priority as ListFilters["priority"]) : null,
    q: (one("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
    sort: pick(one("sort"), ["urgent", "newest", "pay"] as const, "urgent"),
  };
}

/** Statuses included by the "show" filter. */
export function statusesFor(show: ListFilters["show"]): readonly Status[] {
  switch (show) {
    case "active":
      return STATUSES.filter((s) => !["completed", "declined", "expired", "archived"].includes(s));
    case "waiting":
      return ["awaiting_their_response"];
    case "closed":
      return ["completed", "declined", "expired", "archived"];
    default:
      return STATUSES;
  }
}

/** The filter as URL query text, leaving defaults out so links stay short. */
export function filtersToQuery(f: ListFilters, overrides: Partial<ListFilters> = {}): string {
  const merged = { ...f, ...overrides };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged) as Array<[keyof ListFilters, ListFilters[keyof ListFilters]]>) {
    if (v !== null && v !== "" && v !== DEFAULT_FILTERS[k]) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
