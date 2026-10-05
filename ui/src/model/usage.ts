// The Usage view's model (design.md "Usage and accounts (issue #18)"): how a usage reading, a usage
// source, a machine's lane effect and an account are written. `now` is passed in: pure.
import type { MachineLaneEffect, PartAccount, UsageReading, UsageSourceReport } from '../../../src/domain/types.ts';
import { ago } from './format.ts';

/** A reading's window (`session`, `week (Fable)`), else its source's name (a source with one budget). */
export const readingLabel = (r: UsageReading): string => r.window ?? r.source;

export const readingKey = (r: UsageReading): string => `${r.source}|${r.window ?? ''}|${r.machineId ?? ''}`;

/** Readings that throttle lanes first, informational ones after; otherwise as the sources gave them. */
export const orderReadings = (rs: UsageReading[]): UsageReading[] =>
  rs.map((r, i) => ({ r, i })).sort((a, b) => Number(!!a.r.informational) - Number(!!b.r.informational) || a.i - b.i).map((x) => x.r);

/** `resets in 40m` / `2h 5m` / `3d 5h`; empty once past. */
export function resetsIn(iso: string, now: number): string {
  const min = Math.floor((Date.parse(iso) - now) / 60_000);
  if (min <= 0) return '';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return `resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`;
}

/** The one usage source the overview shows of several (issue #85): the chosen one while it reports, else the first. */
export const shownSource = (sources: Pick<UsageSourceReport, 'name'>[], chosen: string | undefined): string | undefined =>
  sources.find((s) => s.name === chosen)?.name ?? sources[0]?.name;

/** What a usage source says about itself: why it has no readings, else when it last read. */
export function sourceLine(s: UsageSourceReport, now: number): { text: string; problem: boolean } {
  if (s.problem) return { text: s.problem, problem: true };
  if (s.refreshedAt) return { text: `read ${ago(s.refreshedAt, now)}`, problem: false };
  return { text: 'no state reported', problem: false };
}

export function laneEffectText(m: Pick<MachineLaneEffect, 'band' | 'cap' | 'maxLanes'>): string {
  switch (m.band) {
    case 'offline': return 'offline: no lanes';
    case 'free': return `all ${m.maxLanes} lanes`;
    case 'soft': return `capped at ${m.cap} of ${m.maxLanes} lanes (past the soft limit)`;
    case 'hard': return `stopped: 0 of ${m.maxLanes} lanes (hard limit)`;
  }
}

/**
 * One line per executor whose budget limits it apart from its machine (issue #140): a machine runs
 * several agent frameworks, and one framework's budget leaves the others' jobs alone.
 */
export function executorEffectLines(m: MachineLaneEffect): string[] {
  return m.executors
    .filter((e) => e.cap !== m.cap || e.band !== m.band)
    .map((e) => `${e.executor}: ${Math.round(e.usedFrac * 100)}% used, ${laneEffectText({ band: e.band, cap: e.cap, maxLanes: m.maxLanes })}`);
}

const SERVICES: Record<string, string> = { claude: 'Claude', github: 'GitHub' };
export const serviceLabel = (service: string): string => SERVICES[service] ?? service;

const FACT_LABELS: Record<string, string> = { installedRepos: 'installed repos', authMethod: 'sign-in' };

/** An account's detail as label/value pairs, in the order the part gave them; empty values left out. */
export const accountFacts = (a: PartAccount): [string, string][] =>
  Object.entries(a.detail).flatMap(([k, v]): [string, string][] => {
    const text = Array.isArray(v) ? v.join(', ') : v;
    return text ? [[FACT_LABELS[k] ?? k, text]] : [];
  });
