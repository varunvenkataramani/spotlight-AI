// Writing to Gmail, only for reply drafts an admin approved: build the reply (RFC 5322 MIME),
// save it as a Gmail draft in the same conversation, or send it. Needs the gmail.compose permission.
import type { GmailContext } from "./api.ts";
import { GmailApiError } from "./api.ts";

export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export const canCompose = (scopes: string[]) =>
  scopes.includes(GMAIL_COMPOSE_SCOPE) || scopes.includes("https://www.googleapis.com/auth/gmail.modify") || scopes.includes("https://mail.google.com/");

/** Header values can never carry line breaks (that's how extra headers get smuggled in). */
const oneLine = (v: string) => v.replace(/[\r\n\u2028\u2029]+/g, " ").trim();

/** RFC 2047 encoded-word for anything that isn't plain ASCII. */
function encodeHeader(value: string): string {
  const v = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  // Split into chunks so each encoded word stays short.
  const words: string[] = [];
  let chunk = "";
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

const EMAIL = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;
export const isEmailAddress = (v: string) => EMAIL.test(v);

/** "Re: " once, never "Re: Re: ". */
export function replySubject(original: string | null): string {
  const s = oneLine(original ?? "").replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, "");
  return `Re: ${s || "your email"}`;
}

export type ReplyMessage = {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
  date?: Date;
};

/** A plain-text reply with threading headers, as Gmail's API expects (base64url of the whole message). */
export function buildReplyMime(m: ReplyMessage): string {
  if (!isEmailAddress(m.from) || !isEmailAddress(m.to)) throw new Error("bad address");
  const msgId = (v: string | null) => (v && /^<[^<>\s]+>$/.test(oneLine(v)) ? oneLine(v) : null);
  const inReplyTo = msgId(m.inReplyTo);
  const refs = (m.references ?? "")
    .split(/\s+/)
    .map((r) => msgId(r))
    .filter((r): r is string => r !== null);
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);
  const body = m.body.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(refs.length ? [`References: ${refs.slice(-10).join(" ")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const encodedBody = (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encodedBody}\r\n`, "utf8").toString("base64url");
}

async function post<T>(ctx: GmailContext, path: string, payload: object): Promise<T> {
  const response = await (ctx.fetchImpl ?? fetch)(`${ctx.baseUrl}/users/me/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { status?: string } };
    throw new GmailApiError(response.status, `Gmail ${path} failed: ${response.status} ${body.error?.status ?? ""}`.trim());
  }
  return (await response.json()) as T;
}

/** Saves the reply as a draft in the same Gmail conversation; someone sends it from Gmail. */
export function createGmailDraft(ctx: GmailContext, raw: string, threadId: string | null) {
  return post<{ id: string; message?: { id: string } }>(ctx, "drafts", { message: { raw, ...(threadId ? { threadId } : {}) } });
}

/** Sends the reply in the same Gmail conversation. */
export function sendGmailMessage(ctx: GmailContext, raw: string, threadId: string | null) {
  return post<{ id: string; threadId?: string }>(ctx, "messages/send", { raw, ...(threadId ? { threadId } : {}) });
}
