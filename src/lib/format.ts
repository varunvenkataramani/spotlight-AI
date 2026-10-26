// How pay and dates read everywhere in Spotlight (Indian number grouping, India time).
import { formatMoney } from "./ai/priority.ts";

export { formatMoney };

const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const DAY_YEAR = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export function formatDay(d: Date | null | undefined, withYear = false): string {
  if (!d) return "";
  return (withYear ? DAY_YEAR : DAY).format(d);
}

export type PayFields = {
  compensation_type: string;
  compensation_status: string;
  amount_min: string | number | null;
  amount_max: string | number | null;
  currency: string;
};

export function payText(o: PayFields): string {
  const min = o.amount_min === null ? null : Number(o.amount_min);
  const max = o.amount_max === null ? null : Number(o.amount_max);
  if (min !== null) {
    const amount = max !== null && max !== min ? `${formatMoney(min, o.currency)}–${formatMoney(max, o.currency)}` : formatMoney(min, o.currency);
    return o.compensation_type === "barter" ? `${amount} in products` : amount;
  }
  if (o.compensation_type === "barter") return "Barter (products, no fee)";
  if (o.compensation_type === "unpaid") return "Unpaid";
  if (o.compensation_status === "requested_rate") return "They ask for her rate";
  return "Pay not mentioned";
}

/** "Due in 3 days", "Due today", "2 days ago", relative to now in whole India-time days. */
export function relativeDay(d: Date, now: Date = new Date()): string {
  const day = (x: Date) => Math.floor((x.getTime() + 5.5 * 3600_000) / 86_400_000);
  const diff = day(d) - day(now);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}
