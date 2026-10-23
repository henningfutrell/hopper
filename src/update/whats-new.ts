// What's new (issue #104, design.md "Self-update"): plain-language bullets, one per change people
// notice, newest first. An update brings the bullets its target has and the installed version does
// not — never commit subjects, hashes or PR numbers.
//
// Fragments (issue #824): a change adds its bullets in a file of its own in `whats-new/`, never in
// WHATS-NEW.md, so two open pull requests never edit the same lines. Before a promotion to beta,
// `node scripts/whats-new.ts assemble` moves them into WHATS-NEW.md. Until then they are newer than
// every line of WHATS-NEW.md, so What's new is the fragments' bullets first, then the file's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WHATS_NEW_FILE = 'WHATS-NEW.md';
/** The fragments' folder: `<issue number>.md` or `<issue number>-<word>.md`, each one or more bullets. */
export const WHATS_NEW_DIR = 'whats-new';
/** The fragments' folder also holds this, which says how to write one; it is not a fragment. */
export const WHATS_NEW_README = 'README.md';

const FRAGMENT = /^(\d+)(-[a-z0-9-]+)?\.md$/;

/** What's new at one version: WHATS-NEW.md and every file of `whats-new/`. */
export interface Notes {
  file: string;
  fragments: { name: string; text: string }[];
}

/** The bullets (`- ` or `* ` lines) of a text, in order; every other line is ignored. */
export function bullets(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const m = /^[-*] (.*)$/.exec(line);
    const b = m?.[1]?.trim();
    return b ? [b] : [];
  });
}

export const isFragment = (name: string): boolean => FRAGMENT.test(name);

/** Words a bullet never has (AGENTS.md "What's new"): an issue or pull request number, a hash, a commit prefix, a file name, a code word. */
const NOT_PLAIN = /#\d+|\b[0-9a-f]{7,40}\b|^\w+(\(.*\))?!?:|\b[\w-]+\.(ts|tsx|sh|md|yaml|json)\b|`/;

/** Whether a bullet breaks the plain-words rule (issue #1483). */
export const breaksPlainWords = (bullet: string): boolean => NOT_PLAIN.test(bullet);

/** The fragments, newest first: the higher issue number first, then by name, backwards (code points, never the locale). */
export function fragmentsInOrder(fragments: Notes['fragments']): Notes['fragments'] {
  const issue = (name: string): number => Number(FRAGMENT.exec(name)?.[1]);
  const backwards = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  return fragments.filter((f) => isFragment(f.name)).sort((a, b) => issue(b.name) - issue(a.name) || backwards(a.name, b.name));
}

/** Every bullet of What's new, newest first: the fragments', then WHATS-NEW.md's. */
export function allBullets(notes: Notes): string[] {
  return [...fragmentsInOrder(notes.fragments).flatMap((f) => bullets(f.text)), ...bullets(notes.file)];
}

/** The target's bullets the installed version does not have, in the target's order. */
export function newSince(installed: string[], target: string[]): string[] {
  const had = new Set(installed);
  return target.filter((b) => !had.has(b));
}

/** WHATS-NEW.md with the fragments' bullets above its first bullet, newest first: the release assembly. */
export function assemble(notes: Notes): string {
  const lines = notes.file.split('\n');
  const added = fragmentsInOrder(notes.fragments).flatMap((f) => bullets(f.text)).map((b) => `- ${b}`);
  const first = lines.findIndex((l) => bullets(l).length > 0);
  if (first >= 0) return [...lines.slice(0, first), ...added, ...lines.slice(first)].join('\n');
  return `${notes.file.replace(/\n*$/, '\n\n')}${added.join('\n')}\n`;
}

/**
 * Why the change from `base` to `head` breaks the What's new rules (issue #824), or none. A bullet goes in a
 * fragment, never straight into WHATS-NEW.md: WHATS-NEW.md gains only bullets the assembly moved there from
 * `base`'s fragments. A released bullet (one `base` has) never changes or goes away: the update notice would
 * show it again as new, but a revert may delete a whole fragment while WHATS-NEW.md stays as it was. A bullet the change adds is in plain words (issue #1483); a released one that is not may be
 * written again, the one way to make it plain.
 */
export function problems(base: Notes, head: Notes): string[] {
  const out: string[] = [];
  for (const f of head.fragments) {
    if (f.name === WHATS_NEW_README) continue;
    if (!isFragment(f.name)) out.push(`${WHATS_NEW_DIR}/${f.name}: name a fragment <issue number>.md or <issue number>-<word>.md`);
    else if (bullets(f.text).length === 0) out.push(`${WHATS_NEW_DIR}/${f.name}: has no "- " line`);
  }
  const fromFragments = new Set(fragmentsInOrder(base.fragments).flatMap((f) => bullets(f.text)));
  const wasInFile = new Set(bullets(base.file));
  for (const b of bullets(head.file)) {
    if (!wasInFile.has(b) && !fromFragments.has(b)) out.push(`${WHATS_NEW_FILE} got a line directly: put it in ${WHATS_NEW_DIR}/<issue number>.md instead: "${b}"`);
  }
  const now = allBullets(head);
  const kept = new Set(now);
  // A revert takes its fragment away whole and leaves WHATS-NEW.md as it was: its lines go with the change.
  const reverted = base.file === head.file ? new Set(base.fragments.filter((f) => !head.fragments.some((h) => h.name === f.name)).flatMap((f) => bullets(f.text))) : new Set<string>();
  const had = new Set(allBullets(base).filter((b) => !reverted.has(b)));
  for (const b of now) {
    if (!had.has(b) && breaksPlainWords(b)) out.push(`a line is not in plain words: no issue numbers, hashes, prefixes, file names or code words: "${b}"`);
  }
  for (const b of had) if (!kept.has(b) && !breaksPlainWords(b)) out.push(`a released line changed or went away; never edit one: "${b}"`);
  const seen = new Set<string>();
  for (const b of now) {
    if (seen.has(b)) out.push(`a line is in What's new twice: "${b}"`);
    seen.add(b);
  }
  return out;
}

/** What's new in a directory: an install, or a checkout. No WHATS-NEW.md or `whats-new/` reads as empty. */
export function readNotes(dir: string): Notes {
  const file = join(dir, WHATS_NEW_FILE);
  const folder = join(dir, WHATS_NEW_DIR);
  const names = existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith('.md')) : [];
  return {
    file: existsSync(file) ? readFileSync(file, 'utf8') : '',
    fragments: names.map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8') })),
  };
}
