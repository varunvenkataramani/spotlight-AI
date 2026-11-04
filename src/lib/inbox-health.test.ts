import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxHealth, STALL_AFTER_MS, TESTING_ACCESS_MS } from "./gmail/health.ts";
import { inboxAdditions, mailQuery } from "./gmail/api.ts";
import { ruleRedFlags } from "./ai/redflags.ts";

const NOW = new Date("2026-11-04T07:30:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const DAY = 86_400_000;
const healthy = { status: "connected", last_synced_at: ago(MIN), consecutive_failures: 0, authorized_at: ago(2 * DAY), connected_at: ago(9 * DAY) };

test("a working inbox is fine, a revoked one needs reconnecting", () => {
  assert.deepEqual(inboxHealth(healthy, NOW), { state: "ok" });
  assert.deepEqual(inboxHealth({ ...healthy, status: "needs_reconnect" }, NOW), { state: "needs_reconnect", since: healthy.last_synced_at });
  assert.equal(inboxHealth({ ...healthy, status: "revoked" }, NOW).state, "needs_reconnect");
  assert.equal(inboxHealth({ ...healthy, status: "disconnected" }, NOW).state, "ok", "a disconnected inbox isn't a problem to shout about");
});

test("an inbox that quietly stops syncing is caught", () => {
  assert.equal(inboxHealth({ ...healthy, consecutive_failures: 3 }, NOW).state, "stalled");
  assert.equal(inboxHealth({ ...healthy, consecutive_failures: 2 }, NOW).state, "ok");
  assert.deepEqual(inboxHealth({ ...healthy, last_synced_at: ago(STALL_AFTER_MS + MIN) }, NOW), { state: "stalled", since: ago(STALL_AFTER_MS + MIN) });
  assert.equal(inboxHealth({ ...healthy, last_synced_at: null, connected_at: ago(STALL_AFTER_MS + MIN) }, NOW).state, "stalled", "never synced at all");
  assert.equal(inboxHealth({ ...healthy, last_synced_at: null, connected_at: ago(MIN) }, NOW).state, "ok", "just connected");
});

test("Google's weekly limit is warned about in its last day only", () => {
  const grantedAt = (msAgo: number) => ({ ...healthy, authorized_at: ago(msAgo) });
  assert.equal(inboxHealth(grantedAt(5 * DAY), NOW).state, "ok");
  const h = inboxHealth(grantedAt(6.5 * DAY), NOW);
  assert.equal(h.state, "expiring");
  assert.equal(h.state === "expiring" && h.endsAt.getTime(), ago(6.5 * DAY).getTime() + TESTING_ACCESS_MS);
  assert.equal(inboxHealth(grantedAt(8 * DAY), NOW).state, "ok", "still working after a week: the app was published, so no more warnings");
  assert.equal(inboxHealth({ ...healthy, authorized_at: null, connected_at: ago(6.5 * DAY) }, NOW).state, "expiring", "older inboxes fall back to when they connected");
});

test("Spam is read only when it's turned on, and it's marked when it is", () => {
  const page = {
    historyId: "9",
    history: [
      { messagesAdded: [{ message: { id: "inbox", threadId: "t", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] } }] },
      { messagesAdded: [{ message: { id: "spam", threadId: "t2", labelIds: ["SPAM"] } }] },
      { messagesAdded: [{ message: { id: "sent", threadId: "t3", labelIds: ["SENT"] } }] },
      { messagesAdded: [{ message: { id: "draft", threadId: "t4", labelIds: ["DRAFT", "INBOX"] } }] },
    ],
  };
  assert.deepEqual(inboxAdditions(page), ["inbox"]);
  assert.deepEqual(inboxAdditions(page, true), ["inbox", "spam"]);
  const after = new Date("2026-11-01T00:00:00Z");
  assert.equal(mailQuery(false, after), `in:inbox after:${after.getTime() / 1000}`);
  assert.equal(mailQuery(true, after), `{in:inbox in:spam} after:${after.getTime() / 1000}`);

  const base = { fromEmail: "team@lavatemedia.example", fromName: "Lavate Media", replyTo: null, subject: "Collab", body: "Paid collab for one reel.", organization: "Lavate Media" };
  assert.deepEqual(ruleRedFlags(base), []);
  const flags = ruleRedFlags({ ...base, labels: ["SPAM"] });
  assert.equal(flags[0]?.flag, "Gmail put this in Spam");
  assert.equal(flags[0]?.severity, "high", "a person checks it before anyone replies");
});
