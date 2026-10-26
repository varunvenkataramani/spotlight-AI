// Minimal Gmail API client: only the read calls Spotlight needs.
import type { GmailMessage } from "./parse.ts";

export type GmailContext = { accessToken: string; baseUrl: string; fetchImpl?: typeof fetch };

export class GmailApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  /** Worth retrying later: rate limits and Google-side errors. */
  get isTransient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function call<T>(ctx: GmailContext, path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(`${ctx.baseUrl}/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.append(k, v);
  const response = await (ctx.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${ctx.accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    // Error bodies can echo request details; keep only the status and Google's short reason.
    const body = (await response.json().catch(() => ({}))) as { error?: { status?: string } };
    throw new GmailApiError(response.status, `Gmail ${path.split("/")[0]} failed: ${response.status} ${body.error?.status ?? ""}`.trim());
  }
  return (await response.json()) as T;
}

export function getProfile(ctx: GmailContext) {
  return call<{ emailAddress: string; historyId: string; messagesTotal?: number }>(ctx, "profile");
}

export function listMessages(ctx: GmailContext, opts: { q: string; pageToken?: string; maxResults?: number }) {
  return call<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(
    ctx,
    "messages",
    { q: opts.q, pageToken: opts.pageToken, maxResults: String(opts.maxResults ?? 100), includeSpamTrash: "false" },
  );
}

export type HistoryPage = {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }> }>;
  nextPageToken?: string;
  historyId: string;
};

export function listHistory(ctx: GmailContext, opts: { startHistoryId: string; pageToken?: string }) {
  return call<HistoryPage>(ctx, "history", {
    startHistoryId: opts.startHistoryId,
    pageToken: opts.pageToken,
    historyTypes: "messageAdded",
    labelId: "INBOX",
    maxResults: "500",
  });
}

export function getMessage(ctx: GmailContext, id: string) {
  return call<GmailMessage>(ctx, `messages/${encodeURIComponent(id)}`, { format: "full" });
}

/** Message ids added to the inbox in a page of history, in order, without duplicates. */
export function inboxAdditions(page: HistoryPage): string[] {
  const seen = new Set<string>();
  for (const h of page.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      const labels = added.message.labelIds;
      if (labels && !labels.includes("INBOX")) continue;
      if (labels && (labels.includes("SPAM") || labels.includes("DRAFT"))) continue;
      seen.add(added.message.id);
    }
  }
  return [...seen];
}
