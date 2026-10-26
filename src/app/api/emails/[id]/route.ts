// Review-queue decisions on single emails: "This is an offer" or "Not an offer".
import { NextResponse, type NextRequest } from "next/server";
import { EditError, reviewEmail } from "@/server/actions.ts";
import { backWith, safeBackPath } from "@/server/form-redirect.ts";
import { isCrossSite, isUuid } from "@/server/request-guard.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (isCrossSite(request)) return NextResponse.json({ error: "cross_site" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const back = safeBackPath(form.get("back"), "/review");

  try {
    const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    const result = await reviewEmail(admin, id, form.get("decision"), aiEnabled);
    return backWith(request, result.opportunityId ? `/opportunities/${result.opportunityId}` : back, "done", result.message);
  } catch (error) {
    if (error instanceof EditError) return backWith(request, back, "error", error.message);
    console.error("Email review failed:", error instanceof Error ? error.message : "unknown error");
    return backWith(request, back, "error", "Something went wrong and nothing was changed. Try again.");
  }
}
