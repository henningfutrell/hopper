// What a card shows first of an agent's text (issue #569): its summary — the first paragraph that is not a heading —,
// and whether the text is long enough that the rest goes behind Show all. Pure: the Markdown source in, plain
// decisions out; the rendering is `@/lib/markdown`.

/** A text up to this many characters and lines shows whole: nothing to fold. */
export const SHORT_CHARS = 600;
export const SHORT_LINES = 8;

/** The most a summary shows; a longer first paragraph is cut at a word and ends with an ellipsis. */
export const SUMMARY_CHARS = 400;

const HEADING = /^\s{0,3}#{1,6}\s/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Whether `text` is long: more than `SHORT_CHARS` characters or `SHORT_LINES` lines. */
export function isLong(text: string): boolean {
  const t = text.trim();
  return t.length > SHORT_CHARS || t.split('\n').length > SHORT_LINES;
}

/**
 * The summary of `text`: its first paragraph that is not a heading, as Markdown, cut at `SUMMARY_CHARS`. A text that
 * opens with a code block has its first line of prose after it; a text of headings and code only has none (empty).
 */
export function summaryOf(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fenced = false;
  const para: string[] = [];
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; if (para.length) break; continue; }
    if (fenced) continue;
    if (line.trim() === '' || HEADING.test(line)) { if (para.length) break; continue; }
    para.push(line);
  }
  const p = para.join('\n').trim();
  if (p.length <= SUMMARY_CHARS) return p;
  const cut = p.slice(0, SUMMARY_CHARS);
  const at = cut.lastIndexOf(' ');
  return `${(at > SUMMARY_CHARS / 2 ? cut.slice(0, at) : cut).trimEnd()} …`;
}
