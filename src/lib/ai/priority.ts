// Priority is plain arithmetic over known facts, with every point explained. The AI never sets it.
// Money alone can't make something high priority: it also needs a near deadline or a preference match.
import type { Classification } from "./schemas.ts";
import type { RedFlag } from "./redflags.ts";

export type Preferences = {
  preferredCategories: string[];
  preferredBrands: string[];
  avoidedBrands: string[];
  preferredLocations: string[];
  /** Minimum fee in INR by category slug; "default" applies to the rest. */
  minimumFeeInr: Record<string, number>;
};

export const EMPTY_PREFERENCES: Preferences = {
  preferredCategories: [],
  preferredBrands: [],
  avoidedBrands: [],
  preferredLocations: [],
  minimumFeeInr: {},
};

export type PriorityInput = {
  classification: Classification;
  confidence: number;
  categorySlug: string | null;
  organization: string | null;
  location: string | null;
  compensation: { type: string; status: string; amountMin: number | null; amountMax: number | null; currency: string; verified: boolean };
  nextDeadline: Date | null;
  latestPastDeadline: Date | null;
  redFlags: RedFlag[];
  cancelled: boolean;
  unverified: string[];
};

export type PriorityResult = { priority: "high" | "medium" | "low" | "needs_review"; score: number; reasons: string[] };

const BASE: Partial<Record<Classification, number>> = {
  new_opportunity: 40,
  availability_request: 45,
  negotiation_or_contract: 50,
  opportunity_update: 40,
  suspicious: 20,
};

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString("en-IN")}`;
  }
}

const includesName = (list: string[], value: string | null) =>
  !!value && list.some((b) => b.trim() && value.toLowerCase().includes(b.trim().toLowerCase()));

function daysUntil(d: Date, now: Date) {
  return (d.getTime() - now.getTime()) / 86_400_000;
}

export function computePriority(input: PriorityInput, prefs: Preferences, now: Date = new Date()): PriorityResult {
  const reasons: string[] = [];
  let score = BASE[input.classification] ?? 30;
  const c = input.compensation;

  // Pay
  if (c.status === "confirmed" || c.status === "range") {
    const amount = c.amountMax ?? c.amountMin;
    if (amount !== null && (c.type === "paid" || c.type === "commission" || c.type === "unspecified")) {
      const shown = c.amountMin !== null && c.amountMax !== null && c.amountMax !== c.amountMin
        ? `${formatMoney(c.amountMin, c.currency)}–${formatMoney(c.amountMax, c.currency)}`
        : formatMoney(amount, c.currency);
      const minimum = input.categorySlug ? (prefs.minimumFeeInr[input.categorySlug] ?? prefs.minimumFeeInr.default) : prefs.minimumFeeInr.default;
      if (c.currency === "INR" && minimum && amount < minimum) {
        score -= 15;
        reasons.push(`Pay ${shown} is below her minimum of ${formatMoney(minimum, "INR")}`);
      } else {
        score += c.status === "confirmed" ? 20 : 15;
        reasons.push(`Paid: ${shown}${c.verified ? "" : " (not confirmed in the email text)"}`);
      }
    }
  } else if (c.status === "requested_rate") {
    score += 10;
    reasons.push("They're asking for her rate");
  }
  if (c.type === "barter" || c.type === "unpaid") {
    score -= 10;
    reasons.push(c.type === "barter" ? "Barter or product only, no fee" : "Unpaid");
  } else if (c.status === "not_disclosed") {
    reasons.push("Pay not mentioned");
  }

  // Timing
  if (input.nextDeadline) {
    const days = daysUntil(input.nextDeadline, now);
    if (days <= 2) {
      score += 25;
      reasons.push(days < 1 ? "Due within a day" : "Due within 2 days");
    } else if (days <= 7) {
      score += 15;
      reasons.push(`Due in ${Math.ceil(days)} days`);
    }
  } else if (input.latestPastDeadline) {
    score -= 25;
    reasons.push("Its dates have already passed");
  }

  // Her preferences
  if (input.categorySlug && prefs.preferredCategories.includes(input.categorySlug)) {
    score += 10;
    reasons.push("A category she prefers");
  }
  if (includesName(prefs.avoidedBrands, input.organization)) {
    score -= 40;
    reasons.push("Brand is on her avoid list");
  } else if (includesName(prefs.preferredBrands, input.organization)) {
    score += 15;
    reasons.push("A brand she likes");
  }
  if (includesName(prefs.preferredLocations, input.location)) {
    score += 5;
    reasons.push("In a preferred location");
  }

  // Warnings
  const high = input.redFlags.filter((f) => f.severity === "high");
  const low = input.redFlags.filter((f) => f.severity === "low");
  score -= high.length * 25 + low.length * 5;
  for (const f of high) reasons.push(`Warning: ${f.flag.charAt(0).toLowerCase()}${f.flag.slice(1)}`);
  if (input.cancelled) {
    score -= 30;
    reasons.push("The sender cancelled or withdrew it");
  }

  const tier: PriorityResult["priority"] = score >= 70 ? "high" : score >= 45 ? "medium" : "low";

  // Things a person should look at before trusting the sorting.
  if (input.classification === "suspicious" || high.length > 0) {
    reasons.unshift("Check before replying: possible scam signs");
    return { priority: "needs_review", score, reasons };
  }
  if (input.confidence < 0.7) {
    reasons.unshift(`The AI wasn't sure about this one (${Math.round(input.confidence * 100)}% confident)`);
    return { priority: "needs_review", score, reasons };
  }
  return { priority: tier, score, reasons };
}
