// Protected resource metadata (RFC 9728) for the connector, served at /.well-known/oauth-protected-resource.
import { NextResponse } from "next/server";
import { readWebConfig } from "@/lib/config.ts";
import { protectedResourceMetadata } from "@/lib/oauth/oauth.ts";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(protectedResourceMetadata(readWebConfig().appUrl), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
