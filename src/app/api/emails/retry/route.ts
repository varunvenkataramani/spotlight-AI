// "Sort them again" on Needs review: emails that failed to sort because of a problem with Claude
// (not because the AI was unsure) go back into the queue.
import { NextResponse, type NextRequest } from "next/server";
import { retryFailedSorting } from "@/server/actions.ts";
import { backWith } from "@/server/form-redirect.ts";
import { isCrossSite } from "@/server/request-guard.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (isCrossSite(request)) return NextResponse.json({ error: "cross_site" }, { status: 403 });
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return backWith(request, "/review", "error", "AI sorting is off: add ANTHROPIC_API_KEY in Vercel first.");
  try {
    return backWith(request, "/review", "done", await retryFailedSorting(admin));
  } catch (error) {
    console.error("Retry sorting failed:", error instanceof Error ? error.message : "unknown error");
    return backWith(request, "/review", "error", "Something went wrong and nothing was changed. Try again.");
  }
}
