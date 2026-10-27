// The public demo: visitors enter as one of two made-up admins, on a database that refills
// itself with made-up offers when it's more than a few hours old (or when someone resets it).
import { NextResponse } from "next/server";
import { DEMO_MANAGER_EMAIL, DEMO_TALENT_EMAIL, isDemoMode } from "@/lib/config.ts";
import { getPool } from "@/lib/db.ts";
import { loadPreferences, rescoreOpportunity } from "@/lib/ai/rescore.ts";
import { buildDemoSeed, DEMO_RESET_AFTER_MS, DEMO_SEEDED_KEY } from "@/lib/demo/seed.ts";
import type { AdminSession } from "@/server/session.ts";

const DEMO_LOCK_ID = 4_721_093;

export { isDemoMode };

/** What a blocked feature says in the demo. */
export const DEMO_BLOCKED = "That isn't available in the demo. It uses made-up offers, so it never connects to Gmail, Claude or Telegram, and nothing is sent.";

/** For routes that must not exist in the demo (sign-in with Google, Gmail, the connector, the scheduler). */
export function demoNotFound(): NextResponse | null {
  return isDemoMode() ? NextResponse.json({ error: "not_available_in_demo" }, { status: 404 }) : null;
}

/** Refills the demo if it's stale (or on request), then returns the session for the chosen admin. */
export async function enterDemo(as: "manager" | "talent", reset: boolean): Promise<AdminSession> {
  if (!isDemoMode()) throw new Error("Not a demo deployment");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One visitor refills at a time; the others wait a moment and see the fresh copy.
    await client.query("SELECT pg_advisory_xact_lock($1)", [DEMO_LOCK_ID]);
    const seeded = await client.query<{ value: unknown }>(`SELECT value FROM preferences WHERE key = $1`, [DEMO_SEEDED_KEY]);
    const seededAt = typeof seeded.rows[0]?.value === "string" ? Date.parse(seeded.rows[0].value) : NaN;
    if (reset || !(seededAt > Date.now() - DEMO_RESET_AFTER_MS)) {
      const seed = buildDemoSeed(new Date());
      await client.query(seed.sql);
      // The same scoring the real app runs after every change, so the demo can't drift from it.
      const prefs = await loadPreferences(client);
      for (const o of seed.offers) await rescoreOpportunity(client, o.id, prefs);
    }
    const email = as === "talent" ? DEMO_TALENT_EMAIL : DEMO_MANAGER_EMAIL;
    const user = await client.query<{ id: string; name: string | null }>(
      `UPDATE users SET last_login_at = now() WHERE email = $1 RETURNING id, name`,
      [email],
    );
    await client.query("COMMIT");
    const row = user.rows[0];
    if (!row) throw new Error("Demo admin missing after refill");
    return { userId: row.id, email, name: row.name };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
