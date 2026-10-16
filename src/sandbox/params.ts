// A sandbox's resource limits (issue #708): a template's own, else these. A need box and a check box run with the
// template's defaults (need-box.ts, check.ts, issue #1349).
import type { ResourceLimits, TemplateLimits } from '../domain/sandboxes.ts';

/** A box of no template, or of a template that sets no limits: what the hopper gives it. */
export const DEFAULT_LIMITS = { cpus: { default: 4, max: 8 }, memoryMb: { default: 8192, max: 16384 } } as const;

/** What a box of a template with these limits runs with: each the template's default, else the hopper's. */
export const boxLimits = (l: TemplateLimits | undefined): ResourceLimits => ({
  cpus: l?.cpus?.default ?? DEFAULT_LIMITS.cpus.default,
  memoryMb: l?.memoryMb?.default ?? DEFAULT_LIMITS.memoryMb.default,
});
