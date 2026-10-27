// Token endpoint: one-time codes and refresh tokens become fresh access tokens for the connector.
import { NextResponse, type NextRequest } from "next/server";
import { readWebConfig } from "@/lib/config.ts";
import { OAuthError } from "@/lib/oauth/oauth.ts";
import { exchangeToken } from "@/server/oauth.ts";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache", "Access-Control-Allow-Origin": "*" };

export async function POST(request: NextRequest) {
  try {
    if (!(request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      throw new OAuthError("invalid_request", "Send the token request as application/x-www-form-urlencoded.");
    }
    const raw = await request.text();
    if (raw.length > 10_000) throw new OAuthError("invalid_request", "Request too large.");
    const config = readWebConfig();
    const tokens = await exchangeToken(new URLSearchParams(raw), request.headers.get("authorization"), config.appUrl, config.admins);
    return NextResponse.json(tokens, { headers: HEADERS });
  } catch (error) {
    if (error instanceof OAuthError) {
      return NextResponse.json(
        { error: error.code, error_description: error.message },
        { status: error.status, headers: { ...HEADERS, ...(error.status === 401 ? { "WWW-Authenticate": 'Basic realm="spotlight"' } : {}) } },
      );
    }
    console.error("Token request failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: HEADERS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
}
