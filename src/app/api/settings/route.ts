// Settings changes from the Settings page, as form posts: alert choices, who the actress is,
// Telegram linking and a test alert.
import { NextResponse, type NextRequest } from "next/server";
import { readWebConfig } from "@/lib/config.ts";
import { EditError } from "@/lib/edits.ts";
import { disconnectTelegram, saveAlertSettings, sendTestAlert, setTalent, startTelegramLink } from "@/server/alerts.ts";
import { backWith } from "@/server/form-redirect.ts";
import { revokeConnection } from "@/server/oauth.ts";
import { isCrossSite } from "@/server/request-guard.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (isCrossSite(request)) return NextResponse.json({ error: "cross_site" }, { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const back = "/settings#alerts";
  try {
    switch (form.get("action")) {
      case "alerts":
        return backWith(request, back, "done", await saveAlertSettings(admin, form));
      case "talent":
        return backWith(request, back, "done", await setTalent(admin, form.get("email"), readWebConfig().admins));
      case "telegram_connect":
        // Straight to the bot in Telegram; pressing Start there links the chat.
        return NextResponse.redirect(await startTelegramLink(admin), 303);
      case "telegram_disconnect":
        return backWith(request, back, "done", await disconnectTelegram(admin));
      case "claude_disconnect":
        return (await revokeConnection(admin.userId, form.get("grant")))
          ? backWith(request, "/settings#claude", "done", "Claude is disconnected. It can't read or change anything until you connect it again.")
          : backWith(request, "/settings#claude", "error", "That connection was already removed.");
      case "test":
        return backWith(request, back, "done", await sendTestAlert(admin));
      default:
        return backWith(request, back, "error", "That action isn't available.");
    }
  } catch (error) {
    if (error instanceof EditError) return backWith(request, back, "error", error.message);
    console.error("Settings change failed:", error instanceof Error ? error.message : "unknown error");
    return backWith(request, back, "error", "Something went wrong and nothing was changed. Try again.");
  }
}
