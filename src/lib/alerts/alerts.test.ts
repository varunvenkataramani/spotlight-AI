import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  answerData,
  emailAlerts,
  opportunityAlerts,
  parseAlertTypes,
  parseAnswerData,
  quietHoursEnd,
  wantsAlert,
  DEFAULT_ALERT_TYPES,
  type AlertEvent,
  type OpportunityState,
} from "./rules.ts";
import { deriveVapidKeys, encryptPayload, isAllowedPushEndpoint, vapidHeader } from "./webpush.ts";
import { alertMessage, escapeHtml, hashLinkCode, isTelegramWebhook, newLinkCode, parseStartCode, webhookSecretFor } from "./telegram.ts";
import { readAlertConfig, ConfigError } from "../config.ts";

const NOW = new Date("2026-10-27T06:30:00Z"); // 12:00 noon in India
const H = 3600_000;
const D = 24 * H;
const ID = "11111111-2222-3333-4444-555555555555";

function opp(over: Partial<OpportunityState> = {}): OpportunityState {
  return {
    id: ID,
    title: "Serum reel",
    organization: "Glow Labs",
    priority: "high",
    status: "new",
    isIrrelevant: false,
    fromHistorical: false,
    createdAt: new Date(NOW.getTime() - 10 * 60_000),
    snoozedUntil: null,
    replyByAt: null,
    eventStartAt: null,
    nextDeadlineAt: null,
    lastTouchAt: new Date(NOW.getTime() - 10 * 60_000),
    pay: "₹75,000",
    redFlagCount: 0,
    flaggedAt: null,
    flagNote: null,
    flaggedByName: null,
    talentResponse: null,
    talentResponseNote: null,
    talentRespondedAt: null,
    ...over,
  };
}
const kinds = (events: AlertEvent[]) => events.map((e) => e.kind).sort();

// --- Web Push ---------------------------------------------------------------------------------------------

test("push encryption matches the published example in RFC 8291", () => {
  const body = encryptPayload(
    "When I grow up, I want to be a watermelon",
    {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverPrivateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url") },
  );
  assert.equal(
    body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

test("a browser can decrypt what the server encrypts", () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = encryptPayload(JSON.stringify({ title: "Hi" }), { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
  // Decrypt as the browser would.
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = body.subarray(21 + idLen);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.equal(plain.at(-1), 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), { title: "Hi" });
});

test("the server push key is stable per secret and signs a valid token", () => {
  const a = deriveVapidKeys("a-session-secret-that-is-long-enough-123");
  const b = deriveVapidKeys("a-session-secret-that-is-long-enough-123");
  const c = deriveVapidKeys("another-session-secret-that-is-long-456");
  assert.equal(a.publicKey, b.publicKey);
  assert.notEqual(a.publicKey, c.publicKey);
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 65);

  const header = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", a, "https://spotlight.example", NOW.getTime());
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m);
  const claims = JSON.parse(Buffer.from(m[2]!, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "https://spotlight.example");
  assert.ok(claims.exp > NOW.getTime() / 1000 && claims.exp <= NOW.getTime() / 1000 + 24 * 3600);
  const pub = Buffer.from(m[4]!, "base64url");
  const publicKey = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
    format: "jwk",
  });
  assert.ok(crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3]!, "base64url")));
});

test("pushes only go to real push services", () => {
  assert.ok(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x"));
  assert.ok(isAllowedPushEndpoint("https://web.push.apple.com/abc"));
  assert.ok(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
  assert.ok(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x"));
  for (const bad of [
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.com/x",
    "https://evil.com/push.apple.com",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "http://169.254.169.254/latest",
    "not a url",
  ]) {
    assert.equal(isAllowedPushEndpoint(bad), false, bad);
  }
  assert.ok(isAllowedPushEndpoint("http://127.0.0.1:4031/push/1", ["http://127.0.0.1:4031"]));
});

// --- Quiet hours -----------------------------------------------------------------------------------------

test("quiet hours delay until they end, across midnight, in India time", () => {
  const at = (iso: string) => new Date(iso);
  // 23:30 IST = 18:00 UTC → ends 08:00 IST = 02:30 UTC next day
  assert.equal(quietHoursEnd(at("2026-10-27T18:00:00Z"), "23:00:00", "08:00:00")?.toISOString(), "2026-10-28T02:30:00.000Z");
  // 07:59 IST → ends a minute later
  assert.equal(quietHoursEnd(at("2026-10-27T02:29:00Z"), "23:00", "08:00")?.toISOString(), "2026-10-27T02:30:00.000Z");
  assert.equal(quietHoursEnd(at("2026-10-27T02:30:00Z"), "23:00", "08:00"), null); // 08:00 is outside
  assert.equal(quietHoursEnd(NOW, "23:00", "08:00"), null); // noon
  assert.ok(quietHoursEnd(at("2026-10-27T08:00:00Z"), "13:00", "15:00")); // 13:30 IST, same-day window
  assert.equal(quietHoursEnd(NOW, "08:00", "08:00"), null);
  assert.equal(quietHoursEnd(NOW, null, "08:00"), null);
});

// --- Rules ------------------------------------------------------------------------------------------------

test("a fresh offer is announced once; old mail and settled offers aren't", () => {
  assert.deepEqual(kinds(opportunityAlerts(opp(), NOW)), ["new_offer"]);
  const [e] = opportunityAlerts(opp(), NOW);
  assert.equal(e!.key, `new_offer:${ID}`);
  assert.equal(e!.title, "New high-priority offer");
  assert.match(e!.body, /Pay: ₹75,000/);
  assert.deepEqual(opportunityAlerts(opp({ fromHistorical: true }), NOW), []);
  assert.deepEqual(opportunityAlerts(opp({ createdAt: new Date(NOW.getTime() - 7 * H) }), NOW), []);
  assert.deepEqual(opportunityAlerts(opp({ isIrrelevant: true }), NOW), []);
  assert.deepEqual(opportunityAlerts(opp({ status: "declined" }), NOW), []);
});

test("people only get the new offers they asked for", () => {
  const high = opportunityAlerts(opp(), NOW)[0]!;
  const medium = opportunityAlerts(opp({ priority: "medium" }), NOW)[0]!;
  const me = (t: Partial<typeof DEFAULT_ALERT_TYPES>) => ({ userId: "u", isTalent: false, types: { ...DEFAULT_ALERT_TYPES, ...t } });
  assert.ok(wantsAlert(me({}), high));
  assert.equal(wantsAlert(me({}), medium), false);
  assert.ok(wantsAlert(me({ newOffers: "all" }), medium));
  assert.equal(wantsAlert(me({ newOffers: "off" }), high), false);
});

test("reply deadlines warn a day ahead, then urgently in the last 3 hours", () => {
  const dayAhead = opportunityAlerts(opp({ createdAt: new Date(NOW.getTime() - 2 * D), replyByAt: new Date(NOW.getTime() + 20 * H) }), NOW);
  assert.deepEqual(kinds(dayAhead), ["reply_due"]);
  assert.equal(dayAhead[0]!.urgent, false);
  assert.match(dayAhead[0]!.body, /Reply by tomorrow, 8:00 am/i);
  const soon = opportunityAlerts(opp({ createdAt: new Date(NOW.getTime() - 2 * D), replyByAt: new Date(NOW.getTime() + 2 * H) }), NOW);
  assert.equal(soon[0]!.urgent, true);
  assert.notEqual(soon[0]!.key, dayAhead[0]!.key);
  assert.deepEqual(opportunityAlerts(opp({ createdAt: new Date(NOW.getTime() - 2 * D), replyByAt: new Date(NOW.getTime() - H) }), NOW), []);
  assert.deepEqual(opportunityAlerts(opp({ createdAt: new Date(NOW.getTime() - 2 * D), replyByAt: new Date(NOW.getTime() + 2 * H), status: "confirmed" }), NOW), []);
});

test("an event the day before, only once she's going ahead with it", () => {
  const base = { createdAt: new Date(NOW.getTime() - 3 * D), lastTouchAt: NOW, eventStartAt: new Date(NOW.getTime() + 5 * H), nextDeadlineAt: new Date(NOW.getTime() + 5 * H) };
  assert.deepEqual(kinds(opportunityAlerts(opp({ ...base, status: "confirmed" }), NOW)), ["event_soon"]);
  assert.deepEqual(opportunityAlerts(opp({ ...base, status: "new" }), NOW), []); // not agreed: no "coming up" for it
});

test("nudges come every few days while it's our turn, then stop", () => {
  const touched = (days: number) => opp({ createdAt: new Date(NOW.getTime() - 20 * D), lastTouchAt: new Date(NOW.getTime() - days * D) });
  assert.deepEqual(opportunityAlerts(touched(1), NOW), []);
  const two = opportunityAlerts(touched(2.5), NOW);
  assert.deepEqual(kinds(two), ["nudge_reply"]);
  assert.match(two[0]!.body, /2 days/);
  assert.equal(opportunityAlerts(touched(4.9), NOW)[0]!.key, two[0]!.key.replace(touched(2.5).lastTouchAt.toISOString(), touched(4.9).lastTouchAt.toISOString()));
  assert.notEqual(opportunityAlerts(touched(5.5), NOW)[0]!.key.split(":").at(-1), two[0]!.key.split(":").at(-1));
  assert.deepEqual(opportunityAlerts(touched(15), NOW), []);
  assert.deepEqual(opportunityAlerts(opp({ ...touched(3), priority: "low" }), NOW), []);
  const waiting = opportunityAlerts(opp({ createdAt: new Date(NOW.getTime() - 20 * D), status: "awaiting_their_response", lastTouchAt: new Date(NOW.getTime() - 6 * D) }), NOW);
  assert.deepEqual(kinds(waiting), ["nudge_follow_up"]);
});

test("snoozed offers stay quiet, then say they're back", () => {
  const old = { createdAt: new Date(NOW.getTime() - 3 * D), replyByAt: new Date(NOW.getTime() + 2 * H) };
  assert.deepEqual(opportunityAlerts(opp({ ...old, snoozedUntil: new Date(NOW.getTime() + D) }), NOW), []);
  assert.deepEqual(kinds(opportunityAlerts(opp({ ...old, lastTouchAt: NOW, snoozedUntil: new Date(NOW.getTime() - H) }), NOW)), ["reply_due", "snooze_ended"]);
});

test("flag for her: only she is asked, with answer buttons; her answer goes to the team", () => {
  const flagged = opp({ createdAt: new Date(NOW.getTime() - 3 * D), lastTouchAt: NOW, flaggedAt: new Date(NOW.getTime() - H), flagNote: "Good brand, decent fee", flaggedByName: "Varun", redFlagCount: 1 });
  const [ask] = opportunityAlerts(flagged, NOW);
  assert.equal(ask!.kind, "flag");
  assert.equal(ask!.audience, "talent");
  assert.deepEqual(ask!.actions.map((a) => a.label), ["Interested", "Pass", "Questions"]);
  assert.match(ask!.body, /Varun: “Good brand, decent fee”/);
  assert.match(ask!.body, /warning signs/);
  const she = { userId: "s", isTalent: true, types: DEFAULT_ALERT_TYPES };
  const him = { userId: "m", isTalent: false, types: { ...DEFAULT_ALERT_TYPES, nudges: false, changes: false, deadlines: false, newOffers: "off" as const } };
  assert.ok(wantsAlert(she, ask!));
  assert.equal(wantsAlert(him, ask!), false);

  const answered = opportunityAlerts({ ...flagged, talentResponse: "questions", talentResponseNote: "Is travel covered?", talentRespondedAt: new Date(NOW.getTime() - 60_000) }, NOW);
  assert.deepEqual(kinds(answered), ["her_answer"]);
  assert.equal(answered[0]!.title, "She said: Has questions");
  assert.match(answered[0]!.body, /“Is travel covered\?”/);
  assert.ok(wantsAlert(him, answered[0]!)); // always goes to the team, whatever they turned off
  assert.equal(wantsAlert(she, answered[0]!), false);
  assert.deepEqual(opportunityAlerts({ ...flagged, flaggedAt: new Date(NOW.getTime() - 8 * D) }, NOW), []);
});

test("their emails make one alert each, saying what changed", () => {
  const ref = { id: ID, title: "Serum reel", organization: "Glow Labs", isIrrelevant: false, status: "interested" };
  const events = emailAlerts(ref, [
    { kind: "email_received", emailId: "e1" },
    { kind: "change_detected", emailId: "e1", field: "compensation", from: "₹75,000", to: "₹90,000" },
    { kind: "change_detected", emailId: "e1", field: "dates", from: "3 Nov", to: "5 Nov" },
    { kind: "email_received", emailId: "e2" },
    { kind: "email_received", emailId: "e3" },
    { kind: "cancellation_detected", emailId: "e3" },
  ]);
  assert.deepEqual(kinds(events), ["cancelled", "terms_changed", "their_email"]);
  const changed = events.find((e) => e.kind === "terms_changed")!;
  assert.equal(changed.key, `email:e1:${ID}`);
  assert.match(changed.body, /Pay: ₹75,000 → ₹90,000\nDate: 3 Nov → 5 Nov/);
  assert.deepEqual(emailAlerts({ ...ref, status: "archived" }, [{ kind: "email_received", emailId: "e9" }]), []);
});

test("answer buttons carry only an id and a letter, and nothing else is accepted", () => {
  const data = answerData(ID, "questions");
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(parseAnswerData(data), { oppId: ID, answer: "questions" });
  assert.deepEqual(parseAnswerData(answerData(ID, "pass")), { oppId: ID, answer: "pass" });
  for (const bad of ["a:not-a-uuid:i", `a:${ID}:x`, `a:${ID}:i;drop`, 5, null, `b:${ID}:i`]) assert.equal(parseAnswerData(bad), null);
});

test("alert settings fall back to safe defaults", () => {
  assert.deepEqual(parseAlertTypes(null), DEFAULT_ALERT_TYPES);
  assert.deepEqual(parseAlertTypes({ new_offers: "all", nudges: false }), { ...DEFAULT_ALERT_TYPES, newOffers: "all", nudges: false });
  assert.equal(parseAlertTypes({ new_offers: "loud" }).newOffers, "high");
});

// --- Telegram ---------------------------------------------------------------------------------------------

test("telegram messages escape email text and only link to https", () => {
  const msg = alertMessage("42", { title: "New <offer>", body: "Glow & Co <b>hi</b>", url: `/opportunities/${ID}`, actions: [{ label: "Pass", data: "a:x:p" }] }, "https://spot.example", true);
  assert.equal(msg.text, "<b>New &lt;offer&gt;</b>\nGlow &amp; Co &lt;b&gt;hi&lt;/b&gt;");
  assert.equal(msg.disable_notification, true);
  assert.deepEqual(msg.reply_markup?.inline_keyboard, [[{ text: "Pass", callback_data: "a:x:p" }], [{ text: "Open in Spotlight", url: `https://spot.example/opportunities/${ID}` }]]);
  const local = alertMessage("42", { title: "t", body: null, url: "/x", actions: [] }, "http://localhost:3000", false);
  assert.equal(local.reply_markup, undefined);
  assert.ok(alertMessage("42", { title: "t", body: "x".repeat(10_000), url: null, actions: [] }, "https://a.b", false).text.length <= 3900);
  assert.equal(escapeHtml("a<b>&"), "a&lt;b&gt;&amp;");
});

test("telegram linking codes and webhook secrets", () => {
  const { code, hash } = newLinkCode();
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(hashLinkCode(code), hash);
  assert.equal(parseStartCode(`/start ${code}`), code);
  assert.equal(parseStartCode(`/start@SpotlightBot ${code}`), code);
  assert.equal(parseStartCode("/start"), null);
  assert.equal(parseStartCode("/start short"), null);
  assert.equal(parseStartCode(`hello ${code}`), null);
  const secret = webhookSecretFor("123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789", "s".repeat(40));
  assert.match(secret, /^[A-Za-z0-9_-]+$/);
  assert.ok(isTelegramWebhook(secret, secret));
  assert.equal(isTelegramWebhook(null, secret), false);
  assert.equal(isTelegramWebhook(secret.slice(1), secret), false);
  assert.notEqual(webhookSecretFor("123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789", "t".repeat(40)), secret);
});

test("alert settings are read from the environment", () => {
  const env = { APP_URL: "https://spot.example/", ADMIN_EMAILS: "a@x.com,b@x.com", SESSION_SECRET: "s".repeat(40) } as unknown as NodeJS.ProcessEnv;
  const c = readAlertConfig(env);
  assert.equal(c.appUrl, "https://spot.example");
  assert.equal(c.telegram, null);
  assert.equal(c.push.subject, "https://spot.example");
  assert.deepEqual(c.push.extraOrigins, []);
  const t = readAlertConfig({ ...env, TELEGRAM_BOT_TOKEN: "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345" } as unknown as NodeJS.ProcessEnv);
  assert.equal(t.telegram?.apiBase, "https://api.telegram.org");
  assert.throws(() => readAlertConfig({ ...env, TELEGRAM_BOT_TOKEN: "my bot" } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test("reminder times are read in India time and must be ahead", async () => {
  const { parseReminderTime, parseClock, EditError } = await import("../edits.ts");
  assert.equal(parseReminderTime("2026-10-28", "10:00", NOW).toISOString(), "2026-10-28T04:30:00.000Z");
  assert.equal(parseReminderTime("2026-10-27", "18:45", NOW).toISOString(), "2026-10-27T13:15:00.000Z");
  assert.throws(() => parseReminderTime("2026-10-27", "09:00", NOW), EditError); // already past
  assert.throws(() => parseReminderTime("2028-01-01", "09:00", NOW), EditError); // over a year
  assert.throws(() => parseReminderTime("", "09:00", NOW), EditError);
  assert.throws(() => parseReminderTime("2026-10-28", "25:00", NOW), EditError);
  assert.throws(() => parseReminderTime("2026-02-30", "09:00", NOW), EditError);
  assert.equal(parseClock("7:05"), "07:05");
  assert.equal(parseClock("23:00:00"), "23:00");
  assert.throws(() => parseClock("11pm"), EditError);
});
