// The disk defaults' setting (issue #2494), apart from settings.ts for its size: a user's key-value setting, `null` when
// cleared, absent when never set.
import type { DiskDefaults } from '../domain/disk-defaults.ts';

export function diskDefaultsSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getDiskDefaults(): DiskDefaults | undefined;
  setDiskDefaults(defaults: DiskDefaults | null): void;
} {
  return {
    getDiskDefaults() {
      const text = read('diskDefaults');
      return (text === undefined ? null : JSON.parse(text) as DiskDefaults | null) ?? undefined;
    },
    setDiskDefaults(defaults) {
      write('diskDefaults', JSON.stringify(defaults));
    },
  };
}

/** How long a read of the disk defaults is kept: the machines are listed at every engine tick, a statement each would load the loop. */
export const DISK_DEFAULTS_READ_MS = 1000;

/** The disk defaults, read from the store at most once each `ms` of real time. */
export function cachedDiskDefaults(read: () => DiskDefaults | undefined, ms = DISK_DEFAULTS_READ_MS, now: () => number = Date.now): () => DiskDefaults | undefined {
  let at = -Infinity, value: DiskDefaults | undefined;
  return () => {
    if (now() - at >= ms) { value = read(); at = now(); }
    return value;
  };
}
