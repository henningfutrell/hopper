// The hopper marker: the hidden first line of a comment the hopper once posted. It posts none
// now, but old ones (claimed, progress, question, answered, finished, and jobs' own
// `kind=job-comment`) remain on issues, so the context filter still tells them from the owner's
// text. The gh source posted as the owner, so the marker is the only way to tell its comments
// from theirs. Those comments were posted before the rename to hopper (issue #112) and carry the
// old product name; they are on GitHub, not ours to rewrite, so the marker keeps it.

const MARKER_LINE_RE = /^<!-- job-hopper v1 /;

export function hasMarker(body: string): boolean {
  return MARKER_LINE_RE.test(body.trimStart());
}

/** Truncate to `max` chars, ending with `note` when cut. */
export function truncate(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}
