export type Chunk = { section: string; ordinal: number; content: string };

type Opts = { maxChars?: number; overlapChars?: number };

/** Strip trailing inline images and markdown attribute blocks from a heading line. */
function cleanHeading(text: string): string {
  const cut = text.indexOf("![");
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

/**
 * Split markdown into heading-scoped sections, then window long sections with overlap.
 *
 * A chunk's `section` is the heading breadcrumb, e.g. "A01:2021 Broken Access Control > Description",
 * not just the nearest heading. The nearest heading alone is usually generic ("Description",
 * "How to Prevent") and loses which risk or technique the text belongs to, which is what a
 * citation and the retrieval eval both need. The document's first heading is treated as its
 * title and left out of the breadcrumb once deeper headings exist.
 */
export function chunkMarkdown(markdown: string, opts: Opts = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 3200;   // "??" means: use this default if none was given
  const overlap = Math.min(opts.overlapChars ?? 400, maxChars - 1);
  const lines = markdown.split(/\r?\n/);    // one entry per line, Windows or Unix line endings

  // Pass 1: group lines under their heading path.
  const sections: { section: string; text: string }[] = [];
  let current = { section: "", text: "" };
  const stack: { level: number; text: string }[] = []; // open headings, outermost first
  let title: string | null = null;                     // the document's first heading
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);   // 1 to 6 "#" then a space, then the text
    if (heading) {
      if (current.text.trim()) sections.push(current); // close the previous section if it had text
      const level = heading[1].length;
      const text = cleanHeading(heading[2]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop(); // leave deeper or equal headings
      stack.push({ level, text });
      if (title === null) title = text;
      const path = stack.map((h) => h.text).filter((t, i) => !(i === 0 && stack.length > 1 && t === title));
      current = { section: path.join(" > "), text: "" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);     // do not forget the last section

  // Pass 2: window each section's text with overlap.
  const out: Chunk[] = [];
  let ordinal = 0;
  for (const { section, text } of sections) {
    const body = text.trim();
    if (!body) continue;
    let start = 0;
    while (start < body.length) {
      const end = Math.min(start + maxChars, body.length);
      out.push({ section, ordinal: ordinal++, content: body.slice(start, end).trim() });
      if (end === body.length) break;                  // reached the end of this section
      start = end - overlap;                           // step back so windows overlap
    }
  }
  return out;
}