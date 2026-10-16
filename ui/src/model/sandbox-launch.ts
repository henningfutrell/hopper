// A template's limits on the page (issue #708): what a person types on a template's form, checked before anything is
// sent, with the server's rule (src/domain/sandboxes.ts limitsProblem) — the server checks again and stays the
// authority. Memory is in GiB here and in MiB on the wire. Pure.
import type { TemplateView } from './wire.ts';

/** A template's limits, as the wire carries them (src/domain/sandboxes.ts TemplateLimits). */
export type TemplateLimits = NonNullable<TemplateView['limits']>;
interface LimitRange { default: number; max: number }

/** A box of no template, or of a template that sets no limits: what the hopper gives it (src/sandbox/params.ts). */
export const DEFAULT_LIMITS = { cpus: { default: 4, max: 8 }, memoryMb: { default: 8192, max: 16384 } } as const;

/** The ranges a box of the template gets: its own, else the hopper's. */
export function launchRanges(t: Pick<TemplateView, 'limits'> | undefined): { cpus: LimitRange; memoryMb: LimitRange } {
  return { cpus: t?.limits?.cpus ?? DEFAULT_LIMITS.cpus, memoryMb: t?.limits?.memoryMb ?? DEFAULT_LIMITS.memoryMb };
}

type Result<K extends string, T> = ({ ok: true } & Record<K, T>) | { ok: false; error: string };

const gib = (mb: number): string => String(Math.round((mb / 1024) * 1000) / 1000);
const mib = (gibs: number): number => Math.round(gibs * 1024);
/** A number more than 0 from what was typed; undefined when it is not one. */
const positive = (s: string): number | undefined => {
  const n = s.trim() === '' ? NaN : Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const NUMBER = 'give a number more than 0';

/** A template's limits as its form holds them: empty where the hopper's default applies. */
export interface LimitsDraft {
  cpus: { default: string; max: string }; memoryGiB: { default: string; max: string };
}

const text = (n: number | undefined, f: (n: number) => string = String): string => (n === undefined ? '' : f(n));

export function limitsDraft(l: TemplateLimits | undefined): LimitsDraft {
  return {
    cpus: { default: text(l?.cpus?.default), max: text(l?.cpus?.max) },
    memoryGiB: { default: text(l?.memoryMb?.default, gib), max: text(l?.memoryMb?.max, gib) },
  };
}

/** The limits a template's form saves, or why they cannot be saved. Empty fields send nothing: the hopper's defaults. */
export function templateLimits(d: LimitsDraft): Result<'limits', TemplateLimits> {
  const range = (label: string, r: { default: string; max: string }, read: (s: string) => number | undefined, unit: (n: number) => string, problem: string): Result<'range', LimitRange | undefined> => {
    const blank = [r.default.trim() === '', r.max.trim() === ''];
    if (blank[0] && blank[1]) return { ok: true, range: undefined };
    if (blank[0] || blank[1]) return { ok: false, error: `${label}: give the default and the max, or neither` };
    const lo = read(r.default), hi = read(r.max);
    if (lo === undefined || hi === undefined) return { ok: false, error: `${label}: ${problem}` };
    return lo > hi ? { ok: false, error: `${label}: the default ${unit(lo)} is more than the max ${unit(hi)}` } : { ok: true, range: { default: lo, max: hi } };
  };
  const cpus = range('CPUs', d.cpus, positive, String, NUMBER);
  if (!cpus.ok) return cpus;
  const memory = range('Memory', d.memoryGiB, (s) => { const n = positive(s); return n === undefined ? undefined : mib(n); }, (n) => `${gib(n)} GiB`, NUMBER);
  if (!memory.ok) return memory;
  return { ok: true, limits: { ...(cpus.range ? { cpus: cpus.range } : {}), ...(memory.range ? { memoryMb: memory.range } : {}) } };
}

/** A template's limits in a few words, the hopper's defaults marked. */
export function limitsText(l: TemplateLimits | undefined): string {
  const r = launchRanges({ limits: l });
  const ours = (set: unknown) => (set ? '' : ' (the hopper\'s)');
  return [
    `${r.cpus.default} CPUs, at most ${r.cpus.max}${ours(l?.cpus)}`,
    `${gib(r.memoryMb.default)} GiB, at most ${gib(r.memoryMb.max)} GiB${ours(l?.memoryMb)}`,
  ].join(' · ');
}
