// The structural pre-check (issue #631, design.md "Sections"): before the reviewer levels, the newest version of a review
// item is checked for structure, with no model call. Each gap is one fixed line: a part left out, no summary (the
// section's first part), a broken link, or a next version the same as the one sent back. Offline: a link is checked for
// form, an anchor against the document's own headings; a relative path is not checked. Pure: no I/O.
import { REVIEW_SECTIONS, type ReviewKind, type ReviewVersion } from '../domain/types.ts';

/** A markdown heading's anchor, as GitHub makes it: `## Notes on paint` → `notes-on-paint`. */
const slug = (heading: string): string => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

const anchors = (text: string): Set<string> =>
  new Set(text.split('\n').flatMap((line) => {
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    return h ? [slug(h)] : [];
  }));

/** A URL with a scheme parses, and a web URL names a host. */
const validUrl = (target: string): boolean => {
  if (!URL.canParse(target)) return false;
  const u = new URL(target);
  return !['http:', 'https:'].includes(u.protocol) || u.hostname !== '';
};

function linkGaps(text: string): string[] {
  const gaps: string[] = [];
  const headings = anchors(text);
  const target = (shown: string, t: string) => {
    const to = t.trim();
    if (!to) gaps.push(`Broken link: ${shown} has no target.`);
    else if (to.startsWith('#')) { if (!headings.has(to.slice(1).toLowerCase())) gaps.push(`Broken link: ${shown} names no heading in the document.`); }
    else if (/^[a-z][a-z0-9+.-]*:/i.test(to) && !validUrl(to)) gaps.push(`Broken link: ${shown} is not a valid URL.`);
  };
  // Markdown links and autolinks first; what is left is read for bare web URLs.
  const rest = text
    .replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, (m: string, _label: string, to: string) => { target(m, to); return ' '; })
    .replace(/<([a-z][a-z0-9+.-]*:[^>\n]*)>/gi, (m: string, to: string) => { target(m, to); return ' '; });
  for (const [m] of rest.matchAll(/\bhttps?:\/\/[^\s<>()]*/gi)) {
    const url = m.replace(/[.,;:!?'"]+$/, '');
    if (!validUrl(url)) gaps.push(`Broken link: ${url} is not a valid URL.`);
  }
  return gaps;
}

/** The gaps in the newest of `versions`, each one fixed line; none: it goes on to the reviewer levels. */
export function preCheck(kind: ReviewKind, versions: readonly ReviewVersion[]): string[] {
  const type = REVIEW_SECTIONS[kind];
  const v = versions.at(-1)!;
  const [summary, ...required] = type.parts;
  const gaps: string[] = [];
  if (v.missing.includes(summary!.id)) gaps.push(`Missing summary: write the ${summary!.label}: part.`);
  for (const p of required) if (v.missing.includes(p.id)) gaps.push(`Missing part: ${p.label}.`);
  gaps.push(...linkGaps(v.text));
  const before = versions.at(-2);
  if (before && before.text.trim() === v.text.trim()) {
    gaps.push(`No change: version ${v.number} is the same as version ${before.number}, so it does not answer the notes on version ${before.number}.`);
  }
  return gaps;
}
