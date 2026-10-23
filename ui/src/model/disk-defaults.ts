// The disk defaults on Machines (issue #2494, design.md "Hopper's own disk use" → "Part 13"): the form, pure. Each field is
// named as the machine option of the same meaning, so a person reads one name for it in both places.
import type { CappedKind, DiskDefaults, EndStatus } from '../../../src/domain/types.ts';

type Place = { at: 'diskLow'; key: keyof NonNullable<DiskDefaults['diskLow']> } | { at: 'sweep'; key: 'everyMinutes' | 'scratchMaxAgeHours' | 'pruneAfterDays' | 'trimAboveGiB' }
  | { at: 'retainHours'; key: EndStatus } | { at: 'cacheCapsGiB'; key: CappedKind };

export interface DiskDefaultField { name: string; label: string; group: string; place: Place }

const retain = (status: EndStatus, name: string): DiskDefaultField => ({ name, label: `Keep a ${status} job's work, hours`, group: 'Retention', place: { at: 'retainHours', key: status } });
const cap = (kind: CappedKind, name: string): DiskDefaultField => ({ name, label: `${kind} cache cap, GiB`, group: 'Cache caps', place: { at: 'cacheCapsGiB', key: kind } });

/** Every field of the form, in its order. */
export const DISK_DEFAULT_FIELDS: readonly DiskDefaultField[] = [
  { name: 'diskLowBelowGiB', label: 'Low below, GiB free', group: 'Thresholds', place: { at: 'diskLow', key: 'belowGiB' } },
  { name: 'diskLowBelowPercent', label: 'Low below, % free', group: 'Thresholds', place: { at: 'diskLow', key: 'belowPercent' } },
  { name: 'diskCriticalBelowGiB', label: 'Critical below, GiB free', group: 'Thresholds', place: { at: 'diskLow', key: 'criticalBelowGiB' } },
  { name: 'diskCriticalBelowPercent', label: 'Critical below, % free', group: 'Thresholds', place: { at: 'diskLow', key: 'criticalBelowPercent' } },
  { name: 'reapEveryMinutes', label: 'Sweep every, minutes', group: 'Sweep', place: { at: 'sweep', key: 'everyMinutes' } },
  { name: 'scratchMaxAgeHours', label: 'Scratch dirs kept, hours', group: 'Sweep', place: { at: 'sweep', key: 'scratchMaxAgeHours' } },
  { name: 'pruneAfterDays', label: 'Days before the storage prune', group: 'Sweep', place: { at: 'sweep', key: 'pruneAfterDays' } },
  { name: 'trimAboveGiB', label: 'Trim after, GiB freed', group: 'Sweep', place: { at: 'sweep', key: 'trimAboveGiB' } },
  retain('finished', 'retainFinishedHours'), retain('failed', 'retainFailedHours'), retain('cancelled', 'retainCancelledHours'), retain('rejected', 'retainRejectedHours'),
  cap('nuget', 'cacheCapNugetGiB'), cap('gradle', 'cacheCapGradleGiB'), cap('go', 'cacheCapGoGiB'), cap('npm', 'cacheCapNpmGiB'),
  cap('pnpm', 'cacheCapPnpmGiB'), cap('yarn', 'cacheCapYarnGiB'), cap('pip', 'cacheCapPipGiB'),
];

/** The form's text of each field, by its name; a field absent or empty has no default. */
export type DiskDefaultsDraft = Partial<Record<string, string>>;

/** What POST /ui/api/machines/disk-defaults is sent for the form, or why not. No field filled: no defaults. */
export function diskDefaultsBody(draft: DiskDefaultsDraft): { defaults: DiskDefaults | null } | string {
  const diskLow: Record<string, number> = {}, sweep: Record<string, unknown> = {}, retainHours: Record<string, number> = {}, cacheCapsGiB: Record<string, number> = {};
  const into = { diskLow, sweep, retainHours, cacheCapsGiB };
  for (const f of DISK_DEFAULT_FIELDS) {
    const t = draft[f.name]?.trim() ?? '';
    if (t === '') continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return `${f.label.split(',')[0]} must be a number, or empty for no default`;
    (into[f.place.at] as Record<string, number>)[f.place.key] = n;
  }
  if (Object.keys(retainHours).length > 0) sweep.retainHours = retainHours;
  if (Object.keys(cacheCapsGiB).length > 0) sweep.cacheCapsGiB = cacheCapsGiB;
  const d: DiskDefaults = { ...(Object.keys(diskLow).length > 0 ? { diskLow } : {}), ...(Object.keys(sweep).length > 0 ? { sweep } : {}) };
  return { defaults: Object.keys(d).length > 0 ? d : null };
}

/** The form for the defaults set: each field that has one. */
export function diskDefaultsDraft(d: DiskDefaults | null): DiskDefaultsDraft {
  const out: DiskDefaultsDraft = {};
  for (const f of DISK_DEFAULT_FIELDS) {
    const from = (f.place.at === 'diskLow' ? d?.diskLow : f.place.at === 'sweep' ? d?.sweep : d?.sweep?.[f.place.at]) as Record<string, unknown> | undefined;
    const v = from?.[f.place.key];
    if (typeof v === 'number') out[f.name] = String(v);
  }
  return out;
}
