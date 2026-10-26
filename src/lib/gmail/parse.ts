// Turns a Gmail API message (format=full) into the fields Spotlight stores.
// Pure and dependency-free. Email content is data: nothing here interprets it.

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

export type Address = { name: string | null; email: string };

export type ParsedEmail = {
  gmailMessageId: string;
  gmailThreadId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  from: Address | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  snippet: string | null;
  bodyText: string;
  receivedAt: Date;
  labels: string[];
  hasAttachments: boolean;
  attachmentNames: string[];
};

export const MAX_BODY_CHARS = 100_000;

export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Decodes RFC 2047 encoded words such as =?UTF-8?B?...?= that some senders put in headers. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      try {
        if (enc.toUpperCase() === "B") return decodeBytes(new Uint8Array(Buffer.from(text, "base64")), charset);
        const bytes: number[] = [];
        const q = text.replace(/_/g, " ");
        for (let i = 0; i < q.length; i++) {
          if (q[i] === "=" && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
            bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(q.charCodeAt(i));
          }
        }
        return decodeBytes(new Uint8Array(bytes), charset);
      } catch {
        return text;
      }
    });
}

/** Splits an address list on commas that are not inside quotes or angle brackets. */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted) angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function parseAddress(raw: string): Address | null {
  const value = decodeMimeWords(raw).trim();
  const angled = value.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (angled) {
    const name = angled[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { name: name || null, email: angled[2]!.toLowerCase() };
  }
  const bare = value.match(/([^\s<>"]+@[^\s<>"]+)/);
  return bare ? { name: null, email: bare[1]!.toLowerCase() } : null;
}

export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return splitAddressList(raw)
    .map(parseAddress)
    .filter((a): a is Address => a !== null)
    .map((a) => a.email);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", copy: "©", reg: "®",
  trade: "™", euro: "€", pound: "£", rupee: "₹", zwnj: "", zwj: "",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return safeCodePoint(parseInt(code.slice(2), 16), m);
    if (code.startsWith("#")) return safeCodePoint(parseInt(code.slice(1), 10), m);
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function safeCodePoint(n: number, fallback: string): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}

/** Readable text from an HTML email: structure becomes line breaks, links keep their address. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = decodeEntities(href.trim());
      if (!/^https?:/i.test(url) || label === url || !label) return label || "";
      return `${label} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<(p|div|tr|h[1-6]|table|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function charsetOf(part: GmailPart): string | null {
  const ct = headerValue(part.headers, "Content-Type") ?? "";
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1]! : null;
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename && part.filename.length > 0) return true;
  const disposition = headerValue(part.headers, "Content-Disposition") ?? "";
  return /^\s*attachment/i.test(disposition);
}

type Collected = { plain: string[]; html: string[]; attachments: string[] };

function walk(part: GmailPart | undefined, acc: Collected): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  if (isAttachment(part)) {
    acc.attachments.push(part.filename || "unnamed attachment");
    return;
  }
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) walk(child, acc);
    return;
  }
  const data = part.body?.data;
  if (!data) return;
  const text = decodeBytes(decodeBase64Url(data), charsetOf(part));
  if (mime === "text/plain") acc.plain.push(text);
  else if (mime === "text/html") acc.html.push(text);
}

export function parseGmailMessage(message: GmailMessage): ParsedEmail {
  const headers = message.payload?.headers;
  const acc: Collected = { plain: [], html: [], attachments: [] };
  walk(message.payload, acc);

  const plain = acc.plain.join("\n\n").trim();
  const html = acc.html.join("\n\n");
  let body = plain.length > 0 ? plain : html ? htmlToText(html) : "";
  body = body.replace(/\r\n?/g, "\n");
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n\n[Message shortened by Spotlight]`;

  const fromRaw = headerValue(headers, "From");
  const subject = headerValue(headers, "Subject");
  const replyTo = parseAddressList(headerValue(headers, "Reply-To"))[0] ?? null;
  const internal = Number(message.internalDate);

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    rfcMessageId: headerValue(headers, "Message-ID")?.trim() ?? null,
    inReplyTo: headerValue(headers, "In-Reply-To")?.trim() ?? null,
    from: fromRaw ? parseAddress(fromRaw) : null,
    replyTo,
    to: parseAddressList(headerValue(headers, "To")),
    cc: parseAddressList(headerValue(headers, "Cc")),
    subject: subject !== undefined ? decodeMimeWords(subject).trim() : null,
    snippet: message.snippet ? decodeEntities(message.snippet) : null,
    bodyText: body,
    receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(),
    labels: message.labelIds ?? [],
    hasAttachments: acc.attachments.length > 0,
    attachmentNames: acc.attachments,
  };
}
