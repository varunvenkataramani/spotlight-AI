import { query } from "@/lib/db.ts";
import type { GoogleIdentity } from "@/lib/google-oidc.ts";

export async function recordAdminLogin(identity: GoogleIdentity): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (email, name, avatar_url, last_login_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_login_at = now()
     RETURNING id`,
    [identity.email, identity.name, identity.picture],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Could not record admin login");
  return id;
}

export type AdminRow = { email: string; name: string | null; last_login_at: Date | null };

export async function listAdmins(): Promise<AdminRow[]> {
  return query<AdminRow>(`SELECT email, name, last_login_at FROM users ORDER BY email`);
}
