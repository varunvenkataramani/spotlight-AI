// Finds where each source quote sits in an email's text, so the detail page can highlight
// exactly the words a value was taken from. Tolerates spacing, case, curly quotes and dashes.

export type Segment = { text: string; mark: boolean };

function pattern(quote: string): RegExp | null {
  const words = quote
    .normalize("NFKC")
    .replace(/^["'‘’“”.… ]+|["'‘’“”.… ]+$/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.join(" ").length < 3) return null;
  const escaped = words.map((w) =>
    w
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/['‘’]/g, "['‘’]")
      .replace(/["“”]/g, '["“”]')
      .replace(/[-‐-―]/g, "[-‐-―]"),
  );
  return new RegExp(escaped.join("\\s+"), "i");
}

export type NumberedSegment = Segment & { n?: number };

/** Like highlight, but each quote can carry a number, so a fact on the page can point at its exact words. */
export function highlightNumbered(text: string, quotes: Array<{ quote: string; n?: number }>): NumberedSegment[] {
  const ranges: Array<[number, number, number | undefined]> = [];
  for (const { quote, n } of quotes) {
    // Quotes with "…" gaps are highlighted piece by piece.
    for (const part of quote.split(/\s*(?:\.\.\.|…)\s*/)) {
      const re = pattern(part);
      const m = re ? re.exec(text) : null;
      if (m && m[0].length > 0) ranges.push([m.index, m.index + m[0].length, n]);
    }
  }
  if (ranges.length === 0) return [{ text, mark: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number, number | undefined]> = [];
  const lower = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
      last[2] = lower(last[2], r[2]);
    } else merged.push([r[0], r[1], r[2]]);
  }

  const out: NumberedSegment[] = [];
  let at = 0;
  for (const [s, e, n] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), mark: false });
    out.push(n === undefined ? { text: text.slice(s, e), mark: true } : { text: text.slice(s, e), mark: true, n });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

export function highlight(text: string, quotes: string[]): Segment[] {
  return highlightNumbered(
    text,
    quotes.map((quote) => ({ quote })),
  ).map(({ text: t, mark }) => ({ text: t, mark }));
}
