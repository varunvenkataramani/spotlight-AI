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

export function listMessages(ctx: GmailContext, opts: { q: string; pageToken?: string; maxResults?: number; includeSpam?: boolean }) {
  return call<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(
    ctx,
    "messages",
    // Spam can only be listed with includeSpamTrash; the query itself keeps Trash out.
    { q: opts.q, pageToken: opts.pageToken, maxResults: String(opts.maxResults ?? 100), includeSpamTrash: opts.includeSpam ? "true" : "false" },
  );
}

/** The Gmail search for the mail Spotlight reads: the inbox, plus Spam when an admin turned that on. */
export function mailQuery(includeSpam: boolean, after: Date): string {
  return `${includeSpam ? "{in:inbox in:spam}" : "in:inbox"} after:${Math.floor(after.getTime() / 1000)}`;
}

export type HistoryPage = {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }> }>;
  nextPageToken?: string;
  historyId: string;
};

export function listHistory(ctx: GmailContext, opts: { startHistoryId: string; pageToken?: string; includeSpam?: boolean }) {
  return call<HistoryPage>(ctx, "history", {
    startHistoryId: opts.startHistoryId,
    pageToken: opts.pageToken,
    historyTypes: "messageAdded",
    // History filters by one label at most; with Spam on, read all additions and filter below.
    labelId: opts.includeSpam ? undefined : "INBOX",
    maxResults: "500",
  });
}

export function getMessage(ctx: GmailContext, id: string) {
  return call<GmailMessage>(ctx, `messages/${encodeURIComponent(id)}`, { format: "full" });
}

/** Message ids added to the inbox (and to Spam, when that's on) in a page of history, in order, without duplicates. */
export function inboxAdditions(page: HistoryPage, includeSpam = false): string[] {
  const seen = new Set<string>();
  for (const h of page.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      const labels = added.message.labelIds;
      if (labels?.includes("DRAFT")) continue;
      if (labels?.includes("SPAM")) {
        if (includeSpam) seen.add(added.message.id);
        continue;
      }
      if (labels && !labels.includes("INBOX")) continue;
      seen.add(added.message.id);
    }
  }
  return [...seen];
}
