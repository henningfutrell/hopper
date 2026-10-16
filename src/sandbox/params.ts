// A sandbox's resource limits (issue #708): a template's own, else these. A need box and a check box run with the
// template's defaults (need-box.ts, check.ts).

/** A box of no template, or of a template that sets no limits: what the hopper gives it. */
export const DEFAULT_LIMITS = { cpus: { default: 4, max: 8 }, memoryMb: { default: 8192, max: 16384 } } as const;
