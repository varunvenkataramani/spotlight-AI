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

export function highlight(text: string, quotes: string[]): Segment[] {
  const ranges: Array<[number, number]> = [];
  for (const q of quotes) {
    // Quotes with "…" gaps are highlighted piece by piece.
    for (const part of q.split(/\s*(?:\.\.\.|…)\s*/)) {
      const re = pattern(part);
      const m = re ? re.exec(text) : null;
      if (m && m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (ranges.length === 0) return [{ text, mark: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const out: Segment[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), mark: false });
    out.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
