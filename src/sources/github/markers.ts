// The hopper marker: the hidden first line of a hopper comment. Today the hopper posts one
// comment per job, the completion status (`kind=finished`). Older hopper comments (claimed,
// progress, question, answered, and jobs' own `kind=job-comment`) carry the same prefix, so the
// context filter still tells them from the owner's text. The gh source posts as the owner, so the
// marker is the only way to tell its comment from his.

export const MARKER_LINE_RE = /^<!-- job-hopper v1 /;

export function finishedMarker(jobId: string): string {
  return `<!-- job-hopper v1 kind=finished job=${jobId} -->`;
}

export function firstLine(body: string): string {
  const i = body.indexOf('\n');
  return (i < 0 ? body : body.slice(0, i)).trim();
}

export function hasMarker(body: string): boolean {
  return MARKER_LINE_RE.test(body.trimStart());
}

/** Truncate to `max` chars, ending with `note` when cut. */
export function truncate(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}
