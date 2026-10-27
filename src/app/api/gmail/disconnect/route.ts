// Disconnects the inbox: revokes Spotlight's Google access and deletes everything stored from it.
import { NextResponse } from "next/server";
import { readGmailConfig } from "@/lib/config.ts";
import { googleEndpoints, revokeToken } from "@/lib/gmail/google.ts";
import { decryptSecret } from "@/lib/token-crypto.ts";
import { DEMO_BLOCKED, isDemoMode } from "@/server/demo.ts";
import { deleteInboxAndData, getInboxForDisconnect } from "@/server/gmail.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const admin = await requireAdmin();
  const go = (outcome: string) => NextResponse.redirect(new URL(`/settings?gmail=${outcome}`, request.url), 303);
  if (isDemoMode()) return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(DEMO_BLOCKED)}`, request.url), 303);

  let confirmed = false;
  try {
    confirmed = (await request.formData()).get("confirm") === "delete";
  } catch {
    // No form body at all: treat as unconfirmed.
  }
  if (!confirmed) return go("confirm_needed");

  const target = await getInboxForDisconnect();
  if (!target) return go("disconnected");

  // Revoke first (best effort): even if Google is unreachable, the data is still deleted below.
  if (target.refresh_token_enc) {
    try {
      const { tokenKey } = readGmailConfig();
      await revokeToken(decryptSecret(target.refresh_token_enc, tokenKey), googleEndpoints());
    } catch {
      // A token we can't decrypt or revoke is deleted with the row anyway.
    }
  }
  await deleteInboxAndData(target, admin.userId);
  return go("disconnected");
}
