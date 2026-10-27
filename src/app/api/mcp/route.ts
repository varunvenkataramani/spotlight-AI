// The Claude connector (MCP over HTTP). Every request needs an access token from Spotlight's own
// OAuth flow; the tools then act as the admin who connected Claude.
import { NextResponse, type NextRequest } from "next/server";
import { ConfigError, readWebConfig } from "@/lib/config.ts";
import { handleMessage, isSupportedVersionHeader } from "@/lib/mcp/protocol.ts";
import { wwwAuthenticate } from "@/lib/oauth/oauth.ts";
import { runConnectorTool } from "@/server/mcp-tools.ts";
import { adminForAccessToken } from "@/server/oauth.ts";

export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com"];
const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, { status, headers });

export async function POST(request: NextRequest) {
  let config;
  try {
    config = readWebConfig();
  } catch (error) {
    if (error instanceof ConfigError) return rpcError(503, "Spotlight isn't set up yet.");
    throw error;
  }
  // Browsers on other sites can't drive the connector (DNS-rebinding protection).
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(config.appUrl).origin && !ALLOWED_ORIGINS.includes(origin)) return rpcError(403, "Origin not allowed.");

  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,200})$/i.exec(auth)?.[1];
  const admin = token ? await adminForAccessToken(token, config.admins, config.appUrl) : null;
  if (!admin) {
    return rpcError(401, "Connect Spotlight in Claude to use it.", {
      "WWW-Authenticate": wwwAuthenticate(config.appUrl, token ? "invalid_token" : undefined),
    });
  }
  if (!isSupportedVersionHeader(request.headers.get("mcp-protocol-version"))) return rpcError(400, "Unsupported MCP-Protocol-Version.");

  const raw = await request.text();
  if (raw.length > 100_000) return rpcError(413, "Request too large.");
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, { status: 400 });
  }
  const response = await handleMessage(message, (name, args) => runConnectorTool(admin, name, args));
  if (response === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}

// No server-initiated stream and no sessions to end.
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
