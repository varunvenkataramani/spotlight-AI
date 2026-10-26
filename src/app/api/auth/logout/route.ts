import { NextResponse } from "next/server";
import { sessionCookieName, sessionCookieOptions } from "@/server/session.ts";

export const dynamic = "force-dynamic";

// POST only, so a link or image elsewhere cannot sign an admin out.
export async function POST(request: Request) {
  const isProduction = process.env.NODE_ENV === "production";
  const response = NextResponse.redirect(new URL("/login?signed_out=1", request.url), 303);
  // Overwrite with the same attributes it was set with (required for __Host- cookies), expired.
  response.cookies.set(sessionCookieName(isProduction), "", { ...sessionCookieOptions(isProduction), maxAge: 0 });
  return response;
}
