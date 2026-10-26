import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayValueIST,
  EditError,
  filtersToQuery,
  parseAmount,
  parseCurrency,
  parseDayIST,
  parseFilters,
  parseLines,
  parseNote,
  parseStatus,
  STAGES,
  STATUSES,
  statusesFor,
  DEFAULT_FILTERS,
} from "./edits.ts";
import { highlight } from "./highlight.ts";
import { payText, relativeDay } from "./format.ts";
import { computePriority, EMPTY_PREFERENCES } from "./ai/priority.ts";

test("amounts typed the Indian way are understood", () => {
  assert.equal(parseAmount("75,000"), 75000);
  assert.equal(parseAmount("₹1,50,000"), 150000);
  assert.equal(parseAmount("Rs. 50000/-"), 50000);
  assert.equal(parseAmount("1.5 lakh"), 150000);
  assert.equal(parseAmount("2 lakhs"), 200000);
  assert.equal(parseAmount("75k"), 75000);
  assert.equal(parseAmount("2 cr"), 20000000);
  assert.equal(parseAmount("  "), null);
  assert.equal(parseAmount(undefined), null);
  for (const bad of ["about 50k", "50-60k", "abc", "-500", "1e9"]) assert.throws(() => parseAmount(bad), EditError, bad);
});

test("currency, status, notes and lists are checked", () => {
  assert.equal(parseCurrency(""), "INR");
  assert.equal(parseCurrency("usd"), "USD");
  assert.throws(() => parseCurrency("rupees"), EditError);
  assert.equal(parseStatus("in_negotiation"), "in_negotiation");
  assert.throws(() => parseStatus("maybe"), EditError);
  assert.equal(parseNote("  Called them,\r\n\r\n\r\n\r\nthey'll send a brief  "), "Called them,\n\nthey'll send a brief");
  assert.throws(() => parseNote("   "), EditError);
  assert.deepEqual(parseLines("- 1 reel\n• 2 stories\n\n3) a post"), ["1 reel", "2 stories", "a post"]);
});

test("dates from the calendar are the end of that day in India", () => {
  assert.equal(parseDayIST("2026-10-30")?.toISOString(), "2026-10-30T18:29:00.000Z");
  assert.equal(parseDayIST("2026-10-30", false)?.toISOString(), "2026-10-29T18:30:00.000Z");
  assert.equal(parseDayIST(""), null);
  assert.throws(() => parseDayIST("2026-02-30"), EditError);
  assert.throws(() => parseDayIST("30/10/2026"), EditError);
  assert.equal(dayValueIST(new Date("2026-10-30T18:29:00Z")), "2026-10-30");
  assert.equal(dayValueIST(null), "");
});

test("every status sits in exactly one board stage", () => {
  const all = STAGES.flatMap((s) => [...s.statuses]);
  assert.equal(all.length, STATUSES.length);
  assert.deepEqual([...all].sort(), [...STATUSES].sort());
});

test("filters ignore junk and keep links short", () => {
  const f = parseFilters({ view: "board", show: "closed", category: "film_entertainment", priority: "urgent!", q: "  Glow   Labs ", sort: "pay" });
  assert.deepEqual(f, { view: "board", show: "closed", category: "film_entertainment", priority: null, q: "Glow Labs", sort: "pay" });
  assert.deepEqual(parseFilters({ category: "'; drop table x;--", show: ["waiting", "all"] }), { ...DEFAULT_FILTERS, show: "waiting" });
  assert.equal(filtersToQuery(DEFAULT_FILTERS), "");
  assert.equal(filtersToQuery(DEFAULT_FILTERS, { q: "glow", view: "board" }), "?view=board&q=glow");
  assert.deepEqual(statusesFor("waiting"), ["awaiting_their_response"]);
  assert.ok(!statusesFor("active").includes("archived"));
});

test("source quotes are highlighted in the email text", () => {
  const body = "Hi Ananya,\nWe’d love a reel.\nBudget:  ₹75,000 (negotiable).\nShoot in Mumbai on 5 Nov.";
  const segs = highlight(body, ["Budget: ₹75,000", "we'd love a reel", "Shoot in Mumbai… 5 Nov", "not in the email"]);
  assert.equal(segs.map((s) => s.text).join(""), body, "nothing is lost or added");
  assert.deepEqual(
    segs.filter((s) => s.mark).map((s) => s.text),
    ["We’d love a reel", "Budget:  ₹75,000", "Shoot in Mumbai", "5 Nov"],
  );
  assert.deepEqual(highlight("plain", []), [{ text: "plain", mark: false }]);
  assert.deepEqual(highlight("a (b) c", ["(b)"]).filter((s) => s.mark).map((s) => s.text), ["(b)"], "regex characters are literal");
});

test("pay and relative days read naturally", () => {
  assert.equal(payText({ compensation_type: "paid", compensation_status: "range", amount_min: "50000.00", amount_max: "75000", currency: "INR" }), "₹50,000–₹75,000");
  assert.equal(payText({ compensation_type: "barter", compensation_status: "not_disclosed", amount_min: null, amount_max: null, currency: "INR" }), "Barter (products, no fee)");
  const now = new Date("2026-10-27T06:00:00Z");
  assert.equal(relativeDay(new Date("2026-10-27T17:00:00Z"), now), "today");
  assert.equal(relativeDay(new Date("2026-10-27T19:00:00Z"), now), "tomorrow", "after midnight in India it's the next day");
  assert.equal(relativeDay(new Date("2026-10-30T06:00:00Z"), now), "in 3 days");
});

test("a checked offer leaves Needs review but keeps its warnings in the reasons", () => {
  const input = {
    classification: "suspicious" as const,
    confidence: 0.85,
    categorySlug: null,
    organization: null,
    location: null,
    compensation: { type: "paid", status: "confirmed", amountMin: 50000, amountMax: 50000, currency: "INR", verified: true },
    nextDeadline: null,
    latestPastDeadline: null,
    redFlags: [{ flag: "Asks for money before the work", evidence: "fee", severity: "high" as const, source: "rule" as const }],
    cancelled: false,
    unverified: [],
  };
  assert.equal(computePriority(input, EMPTY_PREFERENCES).priority, "needs_review");
  const cleared = computePriority({ ...input, reviewCleared: true }, EMPTY_PREFERENCES);
  assert.notEqual(cleared.priority, "needs_review");
  assert.equal(cleared.reasons[0], "Checked by her team");
  assert.ok(cleared.reasons.some((r) => r.startsWith("Warning:")));
});
