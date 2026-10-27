// OAuth authorization server metadata (RFC 8414), served at /.well-known/oauth-authorization-server.
import { NextResponse } from "next/server";
import { readWebConfig } from "@/lib/config.ts";
import { authorizationServerMetadata } from "@/lib/oauth/oauth.ts";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(authorizationServerMetadata(readWebConfig().appUrl), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
