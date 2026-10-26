// One shared Postgres connection pool per server instance (pages, API routes, scheduled runs).
import pg from "pg";
import type { QueryResultRow } from "pg";
import { readDatabaseUrl } from "./config.ts";

type GlobalWithPool = typeof globalThis & { __spotlightPool?: pg.Pool };
const globalRef = globalThis as GlobalWithPool;

/**
 * Hosted Postgres (Supabase) requires TLS. With DATABASE_CA_CERT set (Supabase: Database
 * settings > SSL certificate), the server certificate is fully verified; without it the
 * connection is still encrypted but the certificate is not checked. Local databases skip TLS.
 */
export function sslFor(connectionString: string): pg.ConnectionConfig["ssl"] {
  if (/localhost|127\.0\.0\.1|host=\//.test(connectionString)) return undefined;
  const ca = process.env.DATABASE_CA_CERT;
  return ca ? { ca: ca.replace(/\\n/g, "\n") } : { rejectUnauthorized: false };
}

export function getPool(): pg.Pool {
  if (!globalRef.__spotlightPool) {
    const connectionString = readDatabaseUrl();
    globalRef.__spotlightPool = new pg.Pool({
      connectionString,
      // Serverless instances are many and short-lived: keep each one's share of connections small.
      max: Number(process.env.DATABASE_POOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      ssl: sslFor(connectionString),
    });
  }
  return globalRef.__spotlightPool;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function closePool(): Promise<void> {
  const pool = globalRef.__spotlightPool;
  globalRef.__spotlightPool = undefined;
  await pool?.end();
}
