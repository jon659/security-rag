export type Chunk = { section: string; ordinal: number; content: string };

type Opts = { maxChars?: number; overlapChars?: number };

/** Split markdown into heading-scoped sections, then window long sections with overlap. */
export function chunkMarkdown(markdown: string, opts: Opts = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 3200;   // "??" means: use this default if none was given
  const overlap = opts.overlapChars ?? 400;
  const lines = markdown.split(/\r?\n/);    // one entry per line, Windows or Unix line endings

  // Pass 1: group lines under their nearest heading.
  const sections: { section: string; text: string }[] = [];
  let current = { section: "", text: "" };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);   // a line starting with 1 to 6 "#" then a space
    if (heading) {
      if (current.text.trim()) sections.push(current); // close the previous section if it had text
      current = { section: heading[1].trim(), text: "" };
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