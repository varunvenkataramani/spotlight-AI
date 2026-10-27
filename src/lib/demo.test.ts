import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL, isDemoMode, readAlertConfig, readWebConfig } from "./config.ts";
import { buildDemoSeed, demoScenario, istAt } from "./demo/seed.ts";
import { normalizeForMatch, quoteFound } from "./ai/verify.ts";

const NOW = new Date("2026-10-27T06:30:00Z"); // 12:00 in India

test("demo mode needs no Google or AI settings, and lets in only the two made-up admins", () => {
  const env = { DEMO_MODE: "on", APP_URL: "https://demo.example/", DATABASE_URL: "postgresql://x", SESSION_SECRET: "s".repeat(40) } as unknown as NodeJS.ProcessEnv;
  assert.ok(isDemoMode(env));
  const c = readWebConfig(env);
  assert.equal(c.demo, true);
  assert.equal(c.appUrl, "https://demo.example");
  assert.deepEqual([...c.admins].sort(), [DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL].sort());
  assert.deepEqual([...readAlertConfig(env).admins].sort(), [DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL].sort());
  assert.equal(isDemoMode({ DEMO_MODE: "true" } as unknown as NodeJS.ProcessEnv), false, "only the exact word turns it on");
});

test("demo mode refuses to run next to real accounts", () => {
  const base = { DEMO_MODE: "on", APP_URL: "https://demo.example", DATABASE_URL: "postgresql://x", SESSION_SECRET: "s".repeat(40) };
  for (const real of ["GOOGLE_CLIENT_SECRET", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TOKEN_ENCRYPTION_KEY"]) {
    const env = { ...base, [real]: "x" } as unknown as NodeJS.ProcessEnv;
    assert.throws(() => readWebConfig(env), (e: unknown) => e instanceof ConfigError && e.message.includes(real), real);
    assert.throws(() => readAlertConfig(env), ConfigError, real);
  }
  // And a real deployment is unaffected: it still needs its Google settings.
  assert.equal(readWebConfig({ ...base, DEMO_MODE: "", ADMIN_EMAILS: "a@x.com", GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s" } as unknown as NodeJS.ProcessEnv).demo, false);
});

test("every quote in the demo is really in its email, except the one meant to show the warning", () => {
  const { offers } = demoScenario(NOW);
  let checked = 0;
  for (const o of offers) {
    const src = (i = 0) => normalizeForMatch(`${o.emails[i]!.subject}\n${o.emails[i]!.body}`);
    const fields: Array<[string, { quote: string; email?: number } | undefined]> = [
      ["organization", o.organization],
      ["sender_role", o.senderRole],
      ["contact_phone", o.phone],
      ["location", o.location],
      ["usage_rights", o.usage],
      ["exclusivity", o.exclusivity],
      ["expenses_covered", o.expenses],
      ["requested_action", o.nextStep],
      ["reply_by", o.replyBy],
      ["event_start", o.eventStart],
      ["compensation", o.pay?.quote ? { quote: o.pay.quote, email: o.pay.email } : undefined],
      ["old_compensation", o.oldPay],
    ];
    for (const [name, f] of fields) {
      if (!f) continue;
      checked++;
      const found = quoteFound(f.quote, src(f.email ?? 0));
      assert.equal(found, !(o.unverified ?? []).includes(name), `${o.key}.${name}: “${f.quote}”`);
    }
  }
  assert.ok(checked > 60);
});

test("the rules score the demo offers the way the scenario intends, at any hour", () => {
  for (const hour of [0, 6, 12, 18, 23]) {
    const now = istAt(NOW, 0, hour, 30);
    const seed = buildDemoSeed(now);
    const expected = Object.fromEntries(demoScenario(now).offers.map((o) => [o.key, o.expect]));
    for (const o of seed.offers) assert.equal(o.priority.priority, expected[o.key], `${o.key} at ${hour}:30 → ${o.priority.reasons.join("; ")}`);
  }
});

test("dates line up: emails are in the past, open deadlines in the future, and the scam is flagged", () => {
  const { offers, loose } = demoScenario(NOW);
  for (const o of offers) {
    for (const e of o.emails) assert.ok(e.at < NOW, `${o.key} email in the future`);
    if (!["completed", "archived"].includes(o.status) && o.replyBy) assert.ok(o.replyBy.at > NOW, `${o.key} reply-by passed`);
  }
  for (const e of loose) assert.ok(e.at < NOW);
  const seed = buildDemoSeed(NOW);
  assert.match(seed.sql, /Asks for money before the work/);
  assert.match(seed.sql, /'needs_review'/);
  assert.equal(new Set(seed.offers.map((o) => o.id)).size, seed.offers.length);
});

test("the seed's SQL quotes every value safely", () => {
  const { sql } = buildDemoSeed(NOW);
  assert.doesNotMatch(sql, /\$\{/, "no unfilled template");
  assert.doesNotMatch(sql, /undefined|NaN/);
  assert.match(sql, /Lumora''s own social pages/, "apostrophes are doubled");
  assert.match(sql, /^DELETE FROM gmail_accounts;/);
  assert.doesNotMatch(sql, /DELETE FROM (users|activities|categories)/, "never touches the history log or the admins table directly");
});
