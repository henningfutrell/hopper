// Sandbox strictness in the UI (issue #655 part 8, brake 2), pure: the template lines a person edits — a template's name,
// then its strictness — and what each strictness asks of a person.
import type { RadiusLevel, SandboxStrictness, SandboxStrictnessLevel } from './wire.ts';

export const SANDBOX_STRICTNESS: readonly SandboxStrictnessLevel[] = ['relaxed', 'standard', 'strict', 'locked'];
export const RADIUS: readonly RadiusLevel[] = ['low', 'medium', 'high'];

export const SANDBOX_STRICTNESS_TEXT: Readonly<Record<SandboxStrictnessLevel, string>> = {
  relaxed: 'Relaxed: the sandbox approval toggles and the auto-approve policy decide which runs need no person.',
  standard: 'Standard: the same as relaxed for now. The toggles and the auto-approve policy decide.',
  strict: 'Strict: a person approves each run of a medium or high blast radius template.',
  locked: 'Locked: a person approves each run.',
};

/** The templates, one per line. */
export const formatTemplates = (s: SandboxStrictness): string => Object.entries(s.templates).map(([k, v]) => `${k} ${v}`).join('\n');

export type ParsedTemplates = { ok: true; templates: Record<string, SandboxStrictnessLevel> } | { ok: false; error: string };

/** The templates as typed: a name, then a strictness. Empty lines are skipped. */
export function parseTemplates(text: string): ParsedTemplates {
  const templates: Record<string, SandboxStrictnessLevel> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const [key, value, ...rest] = line.split(/\s+/);
    if (!key || !value || rest.length > 0 || !(SANDBOX_STRICTNESS as readonly string[]).includes(value)) {
      return { ok: false, error: `Line ${i + 1}: "${line}" — write a template name, then relaxed, standard, strict or locked` };
    }
    templates[key] = value as SandboxStrictnessLevel;
  }
  return { ok: true, templates };
}
