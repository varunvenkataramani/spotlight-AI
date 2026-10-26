// Applies db/migrations/*.sql in order, each in its own transaction, exactly once.
// Safe to run on every deploy: an advisory lock stops two runs overlapping, and a
// checksum stops an already-applied migration from being silently edited.
// Usage: DATABASE_URL=... npm run migrate
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { readDatabaseUrl } from "../src/lib/config.ts";
import { sslFor } from "../src/lib/db.ts";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "db", "migrations");
const LOCK_ID = 727_001; // arbitrary, unique to Spotlight migrations

async function main() {
  const connectionString = readDatabaseUrl();
  const client = new pg.Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
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
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      console.log("done");
      ran += 1;
    }
    console.log(ran === 0 ? "Database is up to date." : `Applied ${ran} migration(s).`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
