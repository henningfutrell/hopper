// A template's limits and a launch's parameters on the page (issue #708, design.md "Sandbox boxes the hopper
// launches"): what a person types on a template's form and on Add machine → A sandbox box, checked before anything is
// sent, with the server's rules (src/sandbox/params.ts resolveParams, src/domain/sandboxes.ts limitsProblem) — the
// server checks again and stays the authority. Memory is in GiB here and in MiB on the wire. Pure.
import { BOX_TOOLS } from './vault.ts';
import type { TemplateView } from './wire.ts';

/** A template's limits, as the wire carries them (src/domain/sandboxes.ts TemplateLimits). */
export type TemplateLimits = NonNullable<TemplateView['limits']>;
interface LimitRange { default: number; max: number }

/** A box of no template, or of a template that sets no limits: what the hopper gives it (src/sandbox/params.ts). */
export const DEFAULT_LIMITS = { cpus: { default: 4, max: 8 }, memoryMb: { default: 8192, max: 16384 } } as const;

/** What a launch sends (src/domain/sandboxes.ts LaunchParams). */
export interface LaunchParams { cpus: number; memoryMb: number; ttlMinutes?: number; secrets?: string[]; profile?: string; tools?: string[] }

/** What the launch form holds: the numbers as typed, the secrets and tools chosen, one profile key or none. */
export interface LaunchDraft { cpus: string; memoryGiB: string; ttlMinutes: string; secrets: string[]; profile: string | null; tools: string[] }

type Result<K extends string, T> = ({ ok: true } & Record<K, T>) | { ok: false; error: string };

const gib = (mb: number): string => String(Math.round((mb / 1024) * 1000) / 1000);
const mib = (gibs: number): number => Math.round(gibs * 1024);
/** A number more than 0 from what was typed; undefined when it is not one. */
const positive = (s: string): number | undefined => {
  const n = s.trim() === '' ? NaN : Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const wholeMinutes = (s: string): number | undefined => {
  const n = positive(s);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};
const NUMBER = 'give a number more than 0';
const MINUTES = 'give whole minutes, more than 0';

/** A profile as the launch names it: `operation/kind/name`. */
export const profileKey = (p: TemplateView['profiles'][number]): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;

/** The ranges a launch of the template may ask for: its own, else the hopper's. */
export function launchRanges(t: Pick<TemplateView, 'limits'> | undefined): { cpus: LimitRange; memoryMb: LimitRange; ttlMinutes: { default?: number; max?: number } } {
  return { cpus: t?.limits?.cpus ?? DEFAULT_LIMITS.cpus, memoryMb: t?.limits?.memoryMb ?? DEFAULT_LIMITS.memoryMb, ttlMinutes: t?.limits?.ttlMinutes ?? {} };
}

/** A launch at the template's defaults: its limits, every secret it gives now, all its tools, no profile. */
export function launchDraft(t: TemplateView | undefined): LaunchDraft {
  const r = launchRanges(t);
  return {
    cpus: String(r.cpus.default), memoryGiB: gib(r.memoryMb.default), ttlMinutes: r.ttlMinutes.default === undefined ? '' : String(r.ttlMinutes.default),
    secrets: t?.gives ?? [], profile: null, tools: t?.tools ?? [],
  };
}

/** What a launch sends, or why the template does not allow it, in the words the form shows. */
export function launchParams(d: LaunchDraft, t: TemplateView | undefined): Result<'params', LaunchParams> {
  const r = launchRanges(t);
  const of = t ? `for the template ${t.name}` : 'for a box';
  const cpus = positive(d.cpus);
  if (cpus === undefined) return { ok: false, error: `CPUs: ${NUMBER}` };
  if (cpus > r.cpus.max) return { ok: false, error: `CPUs: at most ${r.cpus.max} ${of}` };
  const memory = positive(d.memoryGiB);
  if (memory === undefined) return { ok: false, error: `Memory: ${NUMBER}` };
  const memoryMb = mib(memory);
  if (memoryMb > r.memoryMb.max) return { ok: false, error: `Memory: at most ${gib(r.memoryMb.max)} GiB ${of}` };
  const ttlMinutes = d.ttlMinutes.trim() === '' ? undefined : wholeMinutes(d.ttlMinutes);
  if (d.ttlMinutes.trim() !== '' && ttlMinutes === undefined) return { ok: false, error: `Time limit: ${MINUTES}` };
  if (ttlMinutes !== undefined && r.ttlMinutes.max !== undefined && ttlMinutes > r.ttlMinutes.max) return { ok: false, error: `Time limit: at most ${r.ttlMinutes.max} minutes ${of}` };
  // The tools in the catalog's order, as the server keeps them.
  const tools = BOX_TOOLS.filter((x) => d.tools.includes(x));
  return {
    ok: true,
    params: {
      cpus, memoryMb, ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
      ...(t ? { secrets: t.gives.filter((s) => d.secrets.includes(s)) } : {}), ...(d.profile ? { profile: d.profile } : {}),
      ...(t || tools.length ? { tools } : {}),
    },
  };
}

/** A template's limits as its form holds them: empty where the hopper's default applies. */
export interface LimitsDraft {
  cpus: { default: string; max: string }; memoryGiB: { default: string; max: string }; ttlMinutes: { default: string; max: string }; keepHome: boolean;
}

const text = (n: number | undefined, f: (n: number) => string = String): string => (n === undefined ? '' : f(n));

export function limitsDraft(l: TemplateLimits | undefined): LimitsDraft {
  return {
    cpus: { default: text(l?.cpus?.default), max: text(l?.cpus?.max) },
    memoryGiB: { default: text(l?.memoryMb?.default, gib), max: text(l?.memoryMb?.max, gib) },
    ttlMinutes: { default: text(l?.ttlMinutes?.default), max: text(l?.ttlMinutes?.max) },
    keepHome: l?.keepHome !== false,
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
  const ttl = { default: d.ttlMinutes.default.trim(), max: d.ttlMinutes.max.trim() };
  const ttlDefault = ttl.default === '' ? undefined : wholeMinutes(ttl.default), ttlMax = ttl.max === '' ? undefined : wholeMinutes(ttl.max);
  if ((ttl.default !== '' && ttlDefault === undefined) || (ttl.max !== '' && ttlMax === undefined)) return { ok: false, error: `Time limit: ${MINUTES}` };
  if (ttlDefault !== undefined && ttlMax !== undefined && ttlDefault > ttlMax) return { ok: false, error: `Time limit: the default ${ttlDefault} minutes is more than the max ${ttlMax} minutes` };
  const ttlMinutes = { ...(ttlDefault !== undefined ? { default: ttlDefault } : {}), ...(ttlMax !== undefined ? { max: ttlMax } : {}) };
  return {
    ok: true,
    limits: {
      ...(cpus.range ? { cpus: cpus.range } : {}), ...(memory.range ? { memoryMb: memory.range } : {}),
      ...(ttlDefault !== undefined || ttlMax !== undefined ? { ttlMinutes } : {}), ...(d.keepHome ? {} : { keepHome: false }),
    },
  };
}

/** A template's limits in a few words, the hopper's defaults marked. */
export function limitsText(l: TemplateLimits | undefined): string {
  const r = launchRanges({ limits: l });
  const ours = (set: unknown) => (set ? '' : ' (the hopper\'s)');
  const ttl = l?.ttlMinutes;
  const time = ttl?.default !== undefined ? `time limit ${ttl.default} minutes${ttl.max !== undefined ? `, at most ${ttl.max}` : ''}`
    : ttl?.max !== undefined ? `no time limit unless a launch sets one, at most ${ttl.max}` : 'no time limit';
  return [
    `${r.cpus.default} CPUs, at most ${r.cpus.max}${ours(l?.cpus)}`,
    `${gib(r.memoryMb.default)} GiB, at most ${gib(r.memoryMb.max)} GiB${ours(l?.memoryMb)}`,
    time,
    l?.keepHome === false ? 'home removed with the box' : 'home kept',
  ].join(' · ');
}
