// Applies db/migrations/*.sql in order, exactly once, all inside one transaction: either every
// new migration lands or none does. Safe to run on every deploy: a transaction-level lock stops
// two runs overlapping (and works through Supabase's transaction pooler), and a checksum stops
// an already-applied migration from being silently edited.
// Usage: DATABASE_URL=... npm run migrate   (Vercel runs it automatically via "vercel-build")
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { readDatabaseUrl } from "../src/lib/config.ts";
import { describeDatabaseUrl } from "../src/lib/database-url.ts";
import { sslFor } from "../src/lib/db.ts";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "db", "migrations");
const LOCK_ID = 727_001; // arbitrary, unique to Spotlight migrations

async function main() {
  // On Vercel this runs before every build. Only production deploys may change the database;
  // preview deploys of a branch must not alter the live schema.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    console.log(`Skipping migrations on a ${process.env.VERCEL_ENV} deploy.`);
    return;
  }
  const connectionString = readDatabaseUrl();
  const client = new pg.Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const applied = new Map(
      (await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

    let ran = 0;
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`${file} was changed after it was applied. Add a new migration instead of editing it.`);
        }
        continue;
      }
      process.stdout.write(`Applying ${file} ... `);
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [file, checksum]);
      console.log("done");
      ran += 1;
    }
    await client.query("COMMIT");
    console.log(ran === 0 ? "Database is up to date." : `Applied ${ran} migration(s).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error instanceof Error ? error.message : error}`);
  const code = (error as { code?: string }).code;
  const connectionProblem =
    code === "28P01" || code === "28000" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "XX000" ||
    /EMAXCONN|max clients/i.test(String((error as Error)?.message));
  if (connectionProblem && process.env.DATABASE_URL) {
    console.error(`DATABASE_URL check: ${describeDatabaseUrl(process.env.DATABASE_URL)}`);
  }
  process.exit(1);
});
