import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCredibility, domainMatchesOrg, senderKey, senderMatches, type CredEmail, type CredInput } from "./ai/credibility.ts";
import { isBulkMail, parseAuthResults, parseGmailMessage } from "./gmail/parse.ts";
import { ruleRedFlags } from "./ai/redflags.ts";

const GOOGLE_AUTH =
  "mx.google.com; dkim=pass header.i=@lavatemedia.example header.s=s1 header.b=abc; spf=pass (google.com: domain of riya@lavatemedia.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=riya@lavatemedia.example; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=lavatemedia.example";

test("Gmail's own sender checks are read, and planted copies are ignored", () => {
  assert.deepEqual(parseAuthResults([{ name: "Authentication-Results", value: GOOGLE_AUTH }]), {
    spf: "pass",
    dkim: "pass",
    dmarc: "pass",
    dkimDomains: ["lavatemedia.example"],
  });
  // Only the topmost header, and only Google's. A sender can write their own lower down.
  assert.equal(parseAuthResults([{ name: "Authentication-Results", value: "evil.example; dmarc=pass" }]), null);
  const spoofed = parseAuthResults([
    { name: "Authentication-Results", value: "mx.google.com; spf=fail smtp.mailfrom=x@brand.example; dmarc=fail (p=REJECT) header.from=brand.example" },
    { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=brand.example" },
  ]);
  assert.equal(spoofed?.dmarc, "fail");
  assert.deepEqual(parseAuthResults([{ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=riya@sub.brand.example; spf=neutral" }])?.dkimDomains, ["sub.brand.example"]);
  assert.equal(parseAuthResults(undefined), null);

  assert.ok(isBulkMail([{ name: "List-Unsubscribe", value: "<mailto:u@x.example>" }]));
  assert.ok(isBulkMail([{ name: "Precedence", value: "bulk" }]));
  assert.equal(isBulkMail([{ name: "Subject", value: "Collab" }]), false);

  const parsed = parseGmailMessage({ id: "m", threadId: "t", payload: { mimeType: "text/plain", headers: [{ name: "Authentication-Results", value: GOOGLE_AUTH }], body: { data: "" } } });
  assert.equal(parsed.auth?.dmarc, "pass");
  assert.equal(parsed.bulk, false);
});

test("a company domain is recognised from the company's name", () => {
  assert.ok(domainMatchesOrg("lavatemedia.example", "Lavate Media"));
  assert.ok(domainMatchesOrg("lavate.media", "Lavate Media"));
  assert.ok(domainMatchesOrg("in.glowlabs.co", "Glow Labs"));
  assert.ok(domainMatchesOrg("kettlehill.example", "Kettle Hill Pictures"));
  assert.equal(domainMatchesOrg("adbuzz.example", "Lavate Media"), false);
  assert.equal(domainMatchesOrg("media.example", "Lavate Media"), false, "a generic word alone isn't a match");
  assert.equal(domainMatchesOrg("kh.example", "Kettle Hill"), false);
  assert.equal(domainMatchesOrg("lavatemedia.example", null), false);
});

test("senders are marked by company domain, or by address when personal", () => {
  assert.equal(senderKey("Riya@LavateMedia.example"), "domain:lavatemedia.example");
  assert.equal(senderKey("lavate.casting@gmail.com"), "address:lavate.casting@gmail.com");
  assert.equal(senderKey(null), null);
  assert.ok(senderMatches(["domain:lavatemedia.example"], "anyone@lavatemedia.example"));
  assert.equal(senderMatches(["address:a@gmail.com"], "b@gmail.com"), false, "marking one Gmail user never marks all of Gmail");
});

const email = (over: Partial<CredEmail> = {}): CredEmail => ({
  fromEmail: "riya@lavatemedia.example",
  fromName: "Riya Kapoor",
  replyTo: null,
  to: ["priya@gmail.com"],
  cc: [],
  subject: "Paid collab with Lavate Media",
  body: "Hi Priya,\nWe'd love you for a paid reel. Fee ₹60,000, shoot on 12 Nov in Mumbai.\nRiya, Talent Partnerships",
  labels: ["INBOX"],
  auth: { spf: "pass", dkim: "pass", dmarc: "pass", dkimDomains: ["lavatemedia.example"] },
  bulk: false,
  ...over,
});
const base = (over: Partial<CredInput> = {}): CredInput => ({
  inbox: "priya@gmail.com",
  talentNames: ["Priya Sharma", "Priya"],
  organization: "Lavate Media",
  emails: [email()],
  facts: { fee: true, deliverables: true, date: true, location: true, role: "Talent Partnerships", phone: false },
  history: { pastDeals: 0, repliedBefore: false },
  trusted: false,
  ...over,
});
const result = (c: ReturnType<typeof assessCredibility>, id: string) => c.checks.find((x) => x.id === id)?.result;

test("a real, personal, specific offer from the company's own verified address looks genuine", () => {
  const c = assessCredibility(base());
  assert.equal(c.verdict, "genuine");
  for (const id of ["domain", "auth", "recipients", "greeting", "specific", "contact"]) assert.equal(result(c, id), "pass", id);
  assert.equal(result(c, "history"), "info");
});

test("a copy-paste blast from a look-alike address is doubtful", () => {
  const c = assessCredibility(
    base({
      emails: [
        email({
          fromEmail: "lavatemedia.official@gmail.com",
          to: ["undisclosed-recipients:;"],
          body: "Dear Talent, exciting collab opportunity! DM us to know more.",
          auth: { spf: "pass", dkim: "pass", dmarc: "pass", dkimDomains: ["gmail.com"] },
          bulk: true,
          labels: ["SPAM"],
        }),
      ],
      facts: { fee: false, deliverables: false, date: false, location: false, role: null, phone: false },
    }),
  );
  assert.equal(c.verdict, "doubtful");
  assert.equal(result(c, "domain"), "warn");
  assert.equal(result(c, "recipients"), "warn");
  assert.equal(result(c, "bulk"), "warn");
  assert.equal(result(c, "greeting"), "warn");
  assert.equal(result(c, "specific"), "warn");
  assert.equal(result(c, "spam"), "fail");
});

test("a forged company address fails Gmail's check, and replies to a personal address are caught", () => {
  const forged = assessCredibility(base({ emails: [email({ auth: { spf: "fail", dkim: "none", dmarc: "fail", dkimDomains: [] } })] }));
  assert.equal(result(forged, "auth"), "fail");
  assert.equal(forged.verdict, "doubtful");
  const redirect = assessCredibility(base({ emails: [email({ replyTo: "lavate.payments@gmail.com" })] }));
  assert.equal(result(redirect, "reply_to"), "fail");
  const unknown = assessCredibility(base({ emails: [email({ auth: null })] }));
  assert.equal(result(unknown, "auth"), "info", "older mail just isn't checked");
  assert.equal(unknown.verdict, "genuine");
});

test("several senders on one offer are listed, middlemen explained", () => {
  const c = assessCredibility(base({ emails: [email(), email({ fromEmail: "neha@lavatemedia.example" }), email({ fromEmail: "deals@adbuzz.example" })] }));
  const s = c.checks.find((x) => x.id === "senders");
  assert.equal(s?.result, "info");
  assert.match(s!.detail, /Sent by 3 people from 2 addresses \(lavatemedia\.example, adbuzz\.example\)/);
  assert.match(s!.detail, /brand's own address is usually the most direct/);
  assert.deepEqual(c.senders, ["riya@lavatemedia.example", "neha@lavatemedia.example", "deals@adbuzz.example"]);
});

test("history and trust count, but a trusted sender can't hide a failed check", () => {
  assert.equal(result(assessCredibility(base({ history: { pastDeals: 2, repliedBefore: false } })), "history"), "pass");
  const casting = base({ emails: [email({ fromEmail: "anil.casting@gmail.com", body: "Dear artist, audition for a web series" })], organization: "Kettle Hill Pictures" });
  assert.equal(assessCredibility(casting).verdict, "careful");
  assert.equal(assessCredibility({ ...casting, trusted: true }).verdict, "genuine");
  const forgedButTrusted = assessCredibility(base({ trusted: true, emails: [email({ auth: { spf: "fail", dkim: "fail", dmarc: "fail", dkimDomains: [] } })] }));
  assert.equal(forgedButTrusted.verdict, "careful");
});

test("a forged sender becomes a warning sign that holds the offer for checking", () => {
  const flags = ruleRedFlags({
    fromEmail: "riya@lavatemedia.example",
    fromName: "Riya",
    replyTo: null,
    subject: "Collab",
    body: "Paid reel.",
    organization: "Lavate Media",
    auth: { dmarc: "fail", spf: "fail", dkim: null },
  });
  assert.equal(flags[0]?.flag, "Failed Gmail's check that it really comes from lavatemedia.example");
  assert.equal(flags[0]?.severity, "high");
  assert.deepEqual(ruleRedFlags({ fromEmail: "a@b.example", fromName: null, replyTo: null, subject: "", body: "", organization: null, auth: { dmarc: "pass", spf: "pass", dkim: "pass" } }), []);
});
