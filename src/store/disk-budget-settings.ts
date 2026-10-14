// The disk budget's setting (issue #1120), apart from settings.ts for its size: a user's key-value setting, `null` when
// turned off, absent when never set.
import type { DiskBudget } from '../domain/types.ts';

export function diskBudgetSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getDiskBudget(): DiskBudget | undefined;
  setDiskBudget(budget: DiskBudget | null): void;
} {
  return {
    getDiskBudget() {
      const text = read('diskBudget');
      const b = text === undefined ? null : JSON.parse(text) as DiskBudget | null;
      return b ? { bytes: b.bytes } : undefined;
    },
    setDiskBudget(budget) {
      write('diskBudget', JSON.stringify(budget ? { bytes: budget.bytes } : null));
    },
  };
}
