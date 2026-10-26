// Scam warning signs found by plain rules. These are warnings with evidence, never a verdict:
// plenty of genuine casting directors write from Gmail, so that one counts as a soft signal.

export type RedFlag = { flag: string; evidence: string; severity: "high" | "low"; source: "rule" | "ai" };

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "rediffmail.com", "protonmail.com", "proton.me",
  "zoho.com", "gmx.com", "mail.com", "yandex.com",
]);

const SHORTENERS = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|shorturl\.at|is\.gd|ow\.ly)\/\S+/i;
const FEE_REQUEST =
  /\b(?:registration|processing|portfolio|audition|onboarding|membership|joining|profile|verification|security|refundable)\s+(?:fee|fees|charges?|deposit|amount)\b[^.\n]{0,80}/i;
const PAY_TO_PROCEED = /\b(?:pay|transfer|deposit)\s+(?:a\s+|the\s+)?(?:small\s+|nominal\s+|one[- ]time\s+)?(?:fee|amount|charge|rs\.?|inr|₹)[^.\n]{0,60}/i;
const PERSONAL_DOCS = /\b(?:aadha?ar(?:\s+card)?|pan\s+card|passport\s+(?:copy|details|number)|bank\s+(?:account\s+)?details|otp|cvv|upi\s+pin)\b[^.\n]{0,60}/i;
const PRESSURE = /\b(?:within\s+(?:the\s+next\s+)?\d{1,2}\s+hours?|today itself|immediately|last chance|limited slots?|act now)\b[^.\n]{0,60}/i;

export function domainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null;
}

function snippet(match: RegExpMatchArray | null): string {
  return match ? match[0].trim().slice(0, 140) : "";
}

export function ruleRedFlags(input: {
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  subject: string | null;
  body: string;
  organization: string | null;
}): RedFlag[] {
  const flags: RedFlag[] = [];
  const text = `${input.subject ?? ""}\n${input.body}`;
  const fromDomain = domainOf(input.fromEmail);
  const replyDomain = domainOf(input.replyTo);
  const org = input.organization?.trim() ?? "";

  const fee = text.match(FEE_REQUEST) ?? text.match(PAY_TO_PROCEED);
  if (fee) flags.push({ flag: "Asks for money before the work", evidence: snippet(fee), severity: "high", source: "rule" });

  const docs = text.match(PERSONAL_DOCS);
  if (docs) flags.push({ flag: "Asks for ID, bank details or codes", evidence: snippet(docs), severity: "high", source: "rule" });

  if (fromDomain && replyDomain && fromDomain !== replyDomain) {
    const toFreeMail = FREE_MAIL_DOMAINS.has(replyDomain) && !FREE_MAIL_DOMAINS.has(fromDomain);
    flags.push({
      flag: toFreeMail ? "Replies go to a personal address, not the company's" : "Replies go to a different domain",
      evidence: `From ${fromDomain}, Reply-To ${replyDomain}`,
      severity: toFreeMail ? "high" : "low",
      source: "rule",
    });
  }

  if (fromDomain && FREE_MAIL_DOMAINS.has(fromDomain) && org && !sameEntity(org, input.fromName)) {
    flags.push({
      flag: `Sent from a personal ${fromDomain} address while presenting as ${org}`,
      evidence: input.fromEmail ?? fromDomain,
      severity: "low",
      source: "rule",
    });
  }

  const short = text.match(SHORTENERS);
  if (short) flags.push({ flag: "Uses a shortened link that hides where it goes", evidence: snippet(short), severity: "low", source: "rule" });

  const pressure = text.match(PRESSURE);
  if (pressure) flags.push({ flag: "Pressure to decide quickly", evidence: snippet(pressure), severity: "low", source: "rule" });

  return flags;
}

function sameEntity(org: string, name: string | null): boolean {
  if (!name) return false;
  const a = org.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return a.length > 0 && (a === b || b.includes(a) || a.includes(b));
}

/** Rule flags plus the AI's own (already quote-checked) flags, without near-duplicates. */
export function mergeRedFlags(rule: RedFlag[], ai: Array<{ flag: string; quote: string }>): RedFlag[] {
  const out = [...rule];
  for (const f of ai) {
    const ev = f.quote.slice(0, 140);
    if (out.some((r) => r.evidence && ev && (r.evidence.includes(ev) || ev.includes(r.evidence)))) continue;
    const high = /fee|payment|deposit|bank|aadha?ar|pan card|passport|otp|impersonat/i.test(f.flag);
    out.push({ flag: f.flag, evidence: ev, severity: high ? "high" : "low", source: "ai" });
  }
  return out;
}
