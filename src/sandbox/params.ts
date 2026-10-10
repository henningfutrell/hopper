// Launch parameters (issue #708): a template is a base skeleton — its image, its approved secrets, its operation
// profiles, and the defaults and maximums of its limits —, and each launch fills in the rest within what it allows.
// Pure. A parameter outside what the template allows is refused with what it allows, never clamped.
import type { LaunchParams, LimitRange, ResolvedParams, TemplateLimits } from '../domain/sandboxes.ts';

export { limitsProblem } from '../domain/sandboxes.ts';

/** A box of no template, or of a template that sets no limits: what the hopper gives it. No time limit. */
export const DEFAULT_LIMITS = { cpus: { default: 4, max: 8 }, memoryMb: { default: 8192, max: 16384 } } as const;

/** What a launch reads of its template: its name, the secrets it gives now, its profiles' keys, its limits. */
export interface LaunchTemplate { name: string; gives: string[]; profiles: string[]; limits?: TemplateLimits | undefined }

export type Resolved = { ok: true; params: ResolvedParams } | { ok: false; error: string };

export function resolveParams(t: LaunchTemplate | undefined, p: LaunchParams): Resolved {
  const who = t ? `the template ${t.name}` : 'a box';
  const fail = (error: string): Resolved => ({ ok: false, error });
  const within = (name: 'cpus' | 'memoryMb', range: LimitRange | undefined): number | string => {
    const r = range ?? DEFAULT_LIMITS[name];
    const v = p[name] ?? r.default;
    if (!(v > 0)) return `${name} must be more than 0`;
    return v > r.max ? `${name} ${v} is more than ${who} allows: at most ${r.max}` : v;
  };
  const cpus = within('cpus', t?.limits?.cpus);
  if (typeof cpus === 'string') return fail(cpus);
  const memoryMb = within('memoryMb', t?.limits?.memoryMb);
  if (typeof memoryMb === 'string') return fail(memoryMb);

  const ttl = t?.limits?.ttlMinutes;
  const ttlMinutes = p.ttlMinutes ?? ttl?.default;
  if (ttlMinutes !== undefined) {
    if (!(ttlMinutes > 0)) return fail('ttlMinutes must be more than 0');
    if (ttl?.max !== undefined && ttlMinutes > ttl.max) return fail(`ttlMinutes ${ttlMinutes} is more than ${who} allows: at most ${ttl.max}`);
  }

  const gives = t?.gives ?? [];
  const secrets = p.secrets ? [...new Set(p.secrets)] : gives;
  const outside = secrets.filter((s) => !gives.includes(s));
  if (outside.length) return fail(t ? `${who} does not give ${outside.join(', ')}: it gives ${gives.join(', ') || 'no secret'}` : `a box of no template gives no secret: ${outside.join(', ')}`);

  if (p.profile !== undefined && !(t?.profiles ?? []).includes(p.profile)) {
    return fail(`${t ? who : 'a box of no template'} has no operation profile ${p.profile}: it has ${t?.profiles.join(', ') || 'none'}`);
  }
  return { ok: true, params: { secrets, cpus, memoryMb, ...(ttlMinutes !== undefined ? { ttlMinutes } : {}), ...(p.profile !== undefined ? { profile: p.profile } : {}) } };
}
