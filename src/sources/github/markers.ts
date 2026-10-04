// The hopper marker: the hidden first line of every hopper comment. The hopper posts as
// The owner (same gh account), so the marker is the only way to tell its comments from his.

export const MARKER_LINE_RE = /^<!-- job-hopper v1 /;

/** What a job prefixes its own comments with (env HOPPER_COMMENT_MARKER). */
export const JOB_COMMENT_MARKER = '<!-- job-hopper v1 kind=job-comment -->';

export type CommentKind = 'claimed' | 'progress' | 'question' | 'answered' | 'finished';

export function markerFor(kind: CommentKind, jobId: string, questionId?: string): string {
  return `<!-- job-hopper v1 kind=${kind} job=${jobId}${questionId ? ` question=${questionId}` : ''} -->`;
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
