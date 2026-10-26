import { NextResponse } from "next/server";

/** Only same-site paths are allowed as a place to go back to after a form. */
export function safeBackPath(raw: FormDataEntryValue | null, fallback: string): string {
  const path = typeof raw === "string" ? raw : "";
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&%.#]*$/.test(path) && path.length < 300 ? path : fallback;
}

/** Back to the page, with a short message the page shows once. */
export function backWith(request: Request, path: string, kind: "done" | "error", message: string): NextResponse {
  const url = new URL(path, request.url);
  url.searchParams.delete("done");
  url.searchParams.delete("error");
  url.searchParams.set(kind, message.slice(0, 200));
  return NextResponse.redirect(url, 303);
}
