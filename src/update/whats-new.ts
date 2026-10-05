// What's new (issue #104, design.md "Self-update"): WHATS-NEW.md at the repository root holds one
// plain-language bullet per change people notice, newest first. An update brings the bullets its
// target has and the installed version does not — never commit subjects, hashes or PR numbers.

export const WHATS_NEW_FILE = 'WHATS-NEW.md';

/** The bullets (`- ` or `* ` lines) of WHATS-NEW.md, in file order; every other line is ignored. */
export function bullets(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const m = /^[-*] (.*)$/.exec(line);
    const b = m?.[1]?.trim();
    return b ? [b] : [];
  });
}

/** The target's bullets the installed version does not have, in the target's order. */
export function newSince(installed: string[], target: string[]): string[] {
  const had = new Set(installed);
  return target.filter((b) => !had.has(b));
}
