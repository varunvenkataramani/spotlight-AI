// Protected resource metadata (RFC 9728) for the connector, served at /.well-known/oauth-protected-resource.
import { NextResponse } from "next/server";
import { demoNotFound } from "@/server/demo.ts";
import { readWebConfig } from "@/lib/config.ts";
import { protectedResourceMetadata } from "@/lib/oauth/oauth.ts";

export const dynamic = "force-dynamic";

export function GET() {
  const blocked = demoNotFound();
  if (blocked) return blocked;
  return NextResponse.json(protectedResourceMetadata(readWebConfig().appUrl), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
