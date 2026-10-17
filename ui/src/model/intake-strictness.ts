// Intake strictness in the UI (issue #655 part 3, brake 1), pure: the overrides as lines a person edits — a job source or
// a repository, then its strictness — and what each strictness lets run.
import type { IntakeStrictness, Strictness } from './wire.ts';

export const STRICTNESS: readonly Strictness[] = ['open', 'standard', 'strict', 'closed'];

export const STRICTNESS_TEXT: Readonly<Record<Strictness, string>> = {
  open: 'Open: a job runs also when its item was only screened, with no person\'s approval.',
  standard: 'Standard: a job runs when its item is from a trusted origin or a person approved it.',
  strict: 'Strict: a job runs only when its item is from a trusted origin. A person\'s approval is not enough.',
  closed: 'Closed: only items you wrote yourself and that were assigned to you run.',
};

/** The overrides, one per line: sources first, then repositories. */
export const formatOverrides = (s: IntakeStrictness): string =>
  [...Object.entries(s.sources), ...Object.entries(s.repos)].map(([k, v]) => `${k} ${v}`).join('\n');

export type ParsedOverrides = { ok: true; sources: Record<string, Strictness>; repos: Record<string, Strictness> } | { ok: false; error: string };

/** The overrides as typed: a line with a slash is a repository (lowercased), else a source. Empty lines are skipped. */
export function parseOverrides(text: string): ParsedOverrides {
  const sources: Record<string, Strictness> = {};
  const repos: Record<string, Strictness> = {};
  const lines = text.split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const [key, value, ...rest] = line.split(/\s+/);
    if (!key || !value || rest.length > 0 || !(STRICTNESS as readonly string[]).includes(value)) {
      return { ok: false, error: `Line ${i + 1}: "${line}" — write a source or owner/name, then open, standard, strict or closed` };
    }
    if (key.includes('/')) repos[key.toLowerCase()] = value as Strictness;
    else sources[key] = value as Strictness;
  }
  return { ok: true, sources, repos };
}
