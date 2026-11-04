// "Can we trust it?" A checklist per offer, worked out by plain rules from what Gmail verified and
// what the emails say. Never a model's opinion: each check says what it looked at. It judges how an
// offer looks, not whether the company will pay; the page says so.
import { domainOf, FREE_MAIL_DOMAINS } from "./redflags.ts";
import { normalizeForMatch } from "./verify.ts";

export type AuthResult = { spf: string | null; dkim: string | null; dmarc: string | null; dkimDomains: string[] };

export type CredEmail = {
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  body: string;
  labels: string[];
  auth: AuthResult | null;
  bulk: boolean;
};

export type CredInput = {
  /** Her inbox address. */
  inbox: string;
  /** Names a personal email would greet her by (first name, full name, stage name). */
  talentNames: string[];
  organization: string | null;
  /** Their emails on this offer, oldest first (not ones she sent). */
  emails: CredEmail[];
  facts: { fee: boolean; deliverables: boolean; date: boolean; location: boolean; role: string | null; phone: boolean };
  history: { pastDeals: number; repliedBefore: boolean };
  trusted: boolean;
};

export type CheckResult = "pass" | "warn" | "fail" | "info";
export type CredCheck = { id: string; label: string; result: CheckResult; detail: string };
export type Verdict = "genuine" | "careful" | "doubtful";
export type Credibility = { verdict: Verdict; summary: string; checks: CredCheck[]; senders: string[] };

export const VERDICT_LABEL: Record<Verdict, string> = { genuine: "Looks genuine", careful: "Check carefully", doubtful: "Doubtful" };

/** How an admin marks a sender: a whole business domain, or one personal address. */
export function senderKey(email: string | null | undefined): string | null {
  const d = domainOf(email);
  if (!d || !email) return null;
  return FREE_MAIL_DOMAINS.has(d) ? `address:${email.toLowerCase()}` : `domain:${d}`;
}

export function senderMatches(keys: string[], email: string | null | undefined): boolean {
  const k = senderKey(email);
  return !!k && keys.includes(k);
}

/** Does the domain look like the company's own? "lavatemedia.com" for "Lavate Media", "in.glowlabs.co" for "Glow Labs". */
export function domainMatchesOrg(domain: string, org: string | null): boolean {
  if (!org) return false;
  const labels = domain.toLowerCase().split(".");
  const name = labels.slice(0, -1).join("").replace(/[^a-z0-9]/g, ""); // everything but the top-level part
  const orgWords = normalizeForMatch(org).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
  const compact = orgWords.join("");
  const main = (labels.at(-2) ?? "").replace(/[^a-z0-9]/g, "");
  if (compact.length >= 4 && (name.includes(compact) || (main.length >= 4 && compact.includes(main)))) return true;
  return orgWords.some((w) => w.length >= 4 && name.includes(w));
}
const GENERIC = new Set(["the", "and", "pvt", "ltd", "llp", "inc", "india", "private", "limited", "company", "group", "official", "team", "studios", "studio", "media", "films", "productions", "entertainment", "agency"]);

const has = (xs: string[], x: string) => xs.some((y) => y.toLowerCase() === x.toLowerCase());

/** Gmail's verdict for the From domain: aligned DKIM or DMARC pass means it's really from there. */
function authCheck(e: CredEmail, fromDomain: string): CredCheck {
  const label = "Really sent from that address";
  const a = e.auth;
  if (!a) return { id: "auth", label, result: "info", detail: "Not checked: this email arrived before Spotlight read Gmail's sender checks." };
  const aligned = a.dkimDomains.some((d) => d === fromDomain || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`));
  if (a.dmarc === "pass" || (a.dkim === "pass" && aligned)) return { id: "auth", label, result: "pass", detail: `Passed Gmail's checks that it really came from ${fromDomain}.` };
  if (a.dmarc === "fail" || (a.spf === "fail" && a.dkim !== "pass")) {
    return { id: "auth", label, result: "fail", detail: `Failed Gmail's check that it came from ${fromDomain}. Someone may be pretending to be them.` };
  }
  return { id: "auth", label, result: "warn", detail: `Gmail couldn't confirm it came from ${fromDomain}.` };
}

export function assessCredibility(input: CredInput): Credibility {
  const checks: CredCheck[] = [];
  const first = input.emails[0];
  const senders = [...new Set(input.emails.map((e) => e.fromEmail?.toLowerCase()).filter((x): x is string => !!x))];
  if (!first?.fromEmail) {
    return { verdict: "careful", summary: VERDICT_LABEL.careful, checks: [{ id: "sender", label: "Who sent it", result: "info", detail: "No sender address to check." }], senders };
  }
  const fromDomain = domainOf(first.fromEmail)!;
  const org = input.organization;
  const personal = FREE_MAIL_DOMAINS.has(fromDomain);

  if (input.trusted) checks.push({ id: "trusted", label: "Trusted sender", result: "pass", detail: "You marked this sender as trusted." });

  // 1. The address itself.
  if (personal) {
    checks.push({
      id: "domain",
      label: "Company email address",
      result: "warn",
      detail: `Writes from a personal ${fromDomain} address. Some casting directors do; brands and agencies usually don't.`,
    });
  } else if (domainMatchesOrg(fromDomain, org)) {
    checks.push({ id: "domain", label: "Company email address", result: "pass", detail: `Writes from ${fromDomain}, which matches ${org}.` });
  } else {
    checks.push({
      id: "domain",
      label: "Company email address",
      result: "info",
      detail: org ? `Writes from ${fromDomain}, which doesn't carry ${org}'s name. It may be an agency acting for them.` : `Writes from ${fromDomain}.`,
    });
  }

  // 2. Gmail's sender checks.
  checks.push(authCheck(first, fromDomain));

  // 3. Where replies would go.
  const replyDomain = domainOf(first.replyTo);
  if (replyDomain && replyDomain !== fromDomain) {
    const toPersonal = FREE_MAIL_DOMAINS.has(replyDomain) && !personal;
    checks.push({
      id: "reply_to",
      label: "Replies go to the same place",
      result: toPersonal ? "fail" : "warn",
      detail: `Replies would go to ${replyDomain}, not ${fromDomain}.`,
    });
  }

  // 4. Sent to her, or to a list.
  const inTo = has(first.to, input.inbox);
  const inCc = has(first.cc, input.inbox);
  const crowd = first.to.length + first.cc.length;
  if (!inTo && !inCc) {
    checks.push({ id: "recipients", label: "Sent to her directly", result: "warn", detail: "She isn't in the To or Cc line, so it went to a hidden list (BCC)." });
  } else if (crowd > 10) {
    checks.push({ id: "recipients", label: "Sent to her directly", result: "warn", detail: `Sent to ${crowd} people at once.` });
  } else if (inTo) {
    checks.push({ id: "recipients", label: "Sent to her directly", result: "pass", detail: crowd > 1 ? `Addressed to her and ${crowd - 1} other${crowd > 2 ? "s" : ""}.` : "Addressed to her alone." });
  } else {
    checks.push({ id: "recipients", label: "Sent to her directly", result: "info", detail: "She was copied in." });
  }
  if (first.bulk) checks.push({ id: "bulk", label: "Written for her, not a mailing", result: "warn", detail: "Sent through a mailing tool: it carries an unsubscribe link." });

  // 5. A personal greeting.
  const names = input.talentNames.map((n) => n.trim()).filter((n) => n.length >= 2);
  if (names.length > 0) {
    const opening = normalizeForMatch(`${first.subject ?? ""}\n${first.body.slice(0, 500)}`);
    const named = names.some((n) => new RegExp(`(^|[^\\p{L}])${escapeRegex(normalizeForMatch(n))}($|[^\\p{L}])`, "u").test(opening));
    checks.push(
      named
        ? { id: "greeting", label: "Uses her name", result: "pass", detail: "Addresses her by name." }
        : { id: "greeting", label: "Uses her name", result: "warn", detail: "Doesn't use her name. Generic openings like “Dear talent” are typical of mass mailings." },
    );
  }

  // 6. Specific about the work.
  const f = input.facts;
  const stated = [f.fee && "the fee", f.deliverables && "what to deliver", f.date && "dates", f.location && "where"].filter((x): x is string => !!x);
  checks.push(
    stated.length >= 3
      ? { id: "specific", label: "Specific about the work", result: "pass", detail: `States ${listWords(stated)}.` }
      : stated.length === 2
        ? { id: "specific", label: "Specific about the work", result: "info", detail: `States ${listWords(stated)}, but not much else.` }
        : { id: "specific", label: "Specific about the work", result: "warn", detail: stated.length ? `Vague: only ${stated[0]} is stated.` : "Vague: no fee, deliverables, dates or place." },
  );

  // 7. A person to deal with.
  checks.push(
    f.role || f.phone
      ? { id: "contact", label: "A real person to deal with", result: "pass", detail: [f.role && `Signed by their ${f.role}`, f.phone && "gives a phone number"].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase()) + "." }
      : { id: "contact", label: "A real person to deal with", result: "info", detail: "No role or phone number given." },
  );

  // 8. History with them.
  const h = input.history;
  checks.push(
    h.pastDeals > 0
      ? { id: "history", label: "Worked together before", result: "pass", detail: `${h.pastDeals} earlier ${h.pastDeals === 1 ? "deal" : "deals"} with this sender.` }
      : h.repliedBefore
        ? { id: "history", label: "Worked together before", result: "pass", detail: "You've written to them before." }
        : { id: "history", label: "Worked together before", result: "info", detail: "The first time they've written." },
  );

  // 9. Gmail's spam filter.
  if (input.emails.some((e) => e.labels.includes("SPAM"))) checks.push({ id: "spam", label: "Not in Spam", result: "fail", detail: "Gmail put it in Spam." });

  // 10. Several senders on one offer.
  if (senders.length > 1) {
    const domains = [...new Set(senders.map((s) => domainOf(s)!))];
    checks.push({
      id: "senders",
      label: "Who else sent it",
      result: "info",
      detail: `Sent by ${senders.length} people from ${domains.length === 1 ? domains[0] : `${domains.length} addresses (${domains.join(", ")})`}. Several agencies often pass on the same brief; the one on the brand's own address is usually the most direct.`,
    });
  }

  const fails = checks.filter((c) => c.result === "fail").length;
  const warns = checks.filter((c) => c.result === "warn").length;
  const verdict: Verdict = fails > 0 ? (input.trusted ? "careful" : "doubtful") : warns >= 2 && !input.trusted ? "careful" : "genuine";
  return { verdict, summary: VERDICT_LABEL[verdict], checks, senders };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listWords(xs: string[]) {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}
