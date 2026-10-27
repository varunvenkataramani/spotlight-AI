// Dynamic client registration (RFC 7591): Claude registers itself before asking an admin to allow it.
// Only Claude's callback addresses are accepted.
import { NextResponse, type NextRequest } from "next/server";
import { OAuthError, parseRegistration } from "@/lib/oauth/oauth.ts";
import { extraRedirects, registerClient } from "@/server/oauth.ts";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    if (raw.length > 10_000) throw new OAuthError("invalid_client_metadata", "Registration too large.");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new OAuthError("invalid_client_metadata", "Send JSON.");
    }
    return NextResponse.json(await registerClient(parseRegistration(body, extraRedirects())), { status: 201, headers: HEADERS });
  } catch (error) {
    if (error instanceof OAuthError) return NextResponse.json({ error: error.code, error_description: error.message }, { status: error.status, headers: HEADERS });
    console.error("Client registration failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: HEADERS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
}
