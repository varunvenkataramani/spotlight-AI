// The "Allow" / "Don't allow" buttons on the connect page. Re-checks everything, then sends the
// browser back to Claude with a one-time code (or a refusal).
import { NextResponse, type NextRequest } from "next/server";
import { readWebConfig } from "@/lib/config.ts";
import { callbackUrl } from "@/lib/oauth/oauth.ts";
import { checkAuthorize, issueCode } from "@/server/oauth.ts";
import { isCrossSite } from "@/server/request-guard.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (isCrossSite(request)) return NextResponse.json({ error: "cross_site" }, { status: 403 });
  const config = readWebConfig();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const check = await checkAuthorize(get, config.appUrl);
  if (check.kind === "show_error") return new NextResponse(check.message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (check.kind === "redirect") return NextResponse.redirect(check.url, 303);

  const { client, params } = check;
  if (get("decision") !== "allow") {
    return NextResponse.redirect(
      callbackUrl(params.redirectUri, { error: "access_denied", error_description: "The admin chose not to connect.", state: params.state, iss: config.appUrl }),
      303,
    );
  }
  const code = await issueCode(admin, client, params, config.appUrl);
  return NextResponse.redirect(callbackUrl(params.redirectUri, { code, state: params.state, iss: config.appUrl }), 303);
}
