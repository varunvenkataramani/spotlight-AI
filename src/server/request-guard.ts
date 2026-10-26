// Extra protection for dashboard actions on top of SameSite cookies: refuse requests that a
// browser marks as coming from another site, and ids that aren't ids.

export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return origin === "null";
  try {
    return new URL(origin).host !== new URL(request.url).host && new URL(origin).host !== hostOf(process.env.APP_URL);
  } catch {
    return true;
  }
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);
