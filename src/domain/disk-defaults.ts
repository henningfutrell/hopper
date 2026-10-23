// The disk defaults (issue #2494, design.md "Hopper's own disk use" → "Part 13"): the disk thresholds and the sweep settings
// a user sets once for every machine. A machine's own option wins; where it is silent, the default applies
// (src/machines/disk-defaults.ts). Kept as a user setting, read at each list of the machines, so a change applies without a restart.
import type { DiskThresholds, SweepSettings } from './machines.ts';

export interface DiskDefaults {
  /** The low and critical thresholds (a machine's `diskLow…` / `diskCritical…` options). */
  diskLow?: DiskThresholds;
  /** How the sweep treats a machine (its `reapEveryMinutes`, `scratchMaxAgeHours`, `retain<Status>Hours`, `pruneAfterDays`, `trimAboveGiB` and `cacheCap<Kind>GiB` options). */
  sweep?: SweepSettings;
}
