// Every change an admin makes to an opportunity arrives here as a form post with an "action".
import { NextResponse, type NextRequest } from "next/server";
import {
  addNote,
  addReminder,
  answerForHer,
  cancelReminder,
  changeStatus,
  correctField,
  EditError,
  flagForHer,
  resolveDuplicate,
  reviewOpportunity,
  snooze,
  withdrawFlag,
} from "@/server/actions.ts";
import { createReplyDraft, discardDraft, saveDraftEdits, saveToGmail, sendDraft } from "@/server/drafts.ts";
import { backWith, safeBackPath } from "@/server/form-redirect.ts";
import { isCrossSite, isUuid } from "@/server/request-guard.ts";
import { requireAdmin } from "@/server/session.ts";

export const dynamic = "force-dynamic";
// Writing a reply with Claude can take a while.
export const maxDuration = 60;

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
  const back = safeBackPath(form.get("back"), `/opportunities/${id}`);

  try {
    switch (form.get("action")) {
      case "status":
        return backWith(request, back, "done", await changeStatus(admin, id, form.get("status")));
      case "note":
        return backWith(request, back, "done", await addNote(admin, id, form.get("text")));
      case "snooze":
        return backWith(request, back, "done", await snooze(admin, id, form.get("days")));
      case "review": {
        const message = await reviewOpportunity(admin, id, form.get("decision"));
        return backWith(request, form.get("decision") === "not_relevant" ? safeBackPath(form.get("back"), "/opportunities") : back, "done", message);
      }
      case "duplicate": {
        const { message, goTo } = await resolveDuplicate(admin, id, form.get("decision"));
        return backWith(request, `/opportunities/${goTo}`, "done", message);
      }
      case "correct":
        return backWith(request, back, "done", await correctField(admin, id, form));
      case "flag":
        return backWith(request, back, "done", await flagForHer(admin, id, form.get("note")));
      case "unflag":
        return backWith(request, back, "done", await withdrawFlag(admin, id));
      case "answer":
        return backWith(request, back, "done", await answerForHer(admin, id, form.get("answer"), form.get("note"), "spotlight"));
      case "remind":
        return backWith(request, back, "done", await addReminder(admin, id, form));
      case "cancel_reminder":
        return backWith(request, back, "done", await cancelReminder(admin, id, form.get("reminder")));
      case "draft": {
        const { message, draftId } = await createReplyDraft(admin, id, form);
        return backWith(request, `/opportunities/${id}${draftId ? `#draft-${draftId}` : "#reply"}`, "done", message);
      }
      case "draft_save":
        return backWith(request, `/opportunities/${id}#draft-${form.get("draft")}`, "done", await saveDraftEdits(admin, id, form));
      case "draft_discard":
        return backWith(request, `/opportunities/${id}#reply`, "done", await discardDraft(admin, id, form));
      case "draft_gmail":
        return backWith(request, `/opportunities/${id}#draft-${form.get("draft")}`, "done", await saveToGmail(admin, id, form));
      case "draft_send":
        return backWith(request, `/opportunities/${id}#draft-${form.get("draft")}`, "done", await sendDraft(admin, id, form));
      default:
        return backWith(request, back, "error", "That action isn't available.");
    }
  } catch (error) {
    if (error instanceof EditError) return backWith(request, back, "error", error.message);
    console.error("Opportunity action failed:", error instanceof Error ? error.message : "unknown error");
    return backWith(request, back, "error", "Something went wrong and nothing was changed. Try again.");
  }
}
