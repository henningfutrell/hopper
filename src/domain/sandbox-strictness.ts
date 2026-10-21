// Sandbox strictness (issue #655 part 8, design.md "Trust stamps"): brake 2 — which sandbox runs gate 2 may approve with
// no person, per template and per blast radius level. An admin sets it in Vault; it is read at each ask, so a
// change applies at once and never needs a restart. It only takes approvals away: the toggles and policies
// (sandbox-approvals.ts) still decide what is approved with no person where the brake lets them. A tightened brake also
// stops a run approved before with no person from counting; a person's approval still counts. Pure.
import type { RadiusLevel } from './blast-radius.ts';

/** Loosest first. */
export const SANDBOX_STRICTNESS = ['relaxed', 'standard', 'strict', 'locked'] as const;
export type SandboxStrictnessLevel = typeof SANDBOX_STRICTNESS[number];

/**
 * The brake: `default` for every template, `radius` by the template's blast radius level, `templates` by its name. The
 * most specific wins: the template, else its radius level, else the default.
 */
export interface SandboxStrictness {
  default: SandboxStrictnessLevel;
  radius: Partial<Record<RadiusLevel, SandboxStrictnessLevel>>;
  templates: Record<string, SandboxStrictnessLevel>;
}

export const DEFAULT_SANDBOX_STRICTNESS: SandboxStrictness = { default: 'standard', radius: {}, templates: {} };

/** The brake on one template: its strictness, and where that was set. */
export interface SandboxBrake { strictness: SandboxStrictnessLevel; at: 'default' | { radius: RadiusLevel } | { template: string } }

/** What the brake reads of a template: its name and its blast radius. Undefined: no such template, so no radius. */
type Rated = { name: string; radius?: { level: RadiusLevel } } | undefined;

/** The brake on runs of `template`. */
export function sandboxBrakeOf(s: SandboxStrictness, template: Rated): SandboxBrake {
  const byTemplate = template ? s.templates[template.name] : undefined;
  if (byTemplate && template) return { strictness: byTemplate, at: { template: template.name } };
  const level = template?.radius?.level;
  const byRadius = level ? s.radius[level] : undefined;
  if (byRadius && level) return { strictness: byRadius, at: { radius: level } };
  return { strictness: s.default, at: 'default' };
}

/**
 * The brake when it asks a person for each run of `template`: `locked` always; `strict` for a medium or high radius, and
 * for a template with no radius (fail closed). Undefined: `relaxed` and `standard` ask for nobody: the toggles decide.
 */
export function personBrake(s: SandboxStrictness, template: Rated): SandboxBrake | undefined {
  const b = sandboxBrakeOf(s, template);
  if (b.strictness === 'locked') return b;
  if (b.strictness === 'strict' && template?.radius?.level !== 'low') return b;
  return undefined;
}

/** The brake in plain words, for a refusal or a hold. */
export const sandboxBrakeText = (b: SandboxBrake): string =>
  `sandbox strictness ${b.strictness} ${b.at === 'default' ? 'by default' : 'template' in b.at ? `for the template ${b.at.template}` : `for ${b.at.radius} blast radius`}`;
