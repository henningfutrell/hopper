// The memory alert's setting (issue #868), apart from settings.ts for its size: a user's key-value setting, `null` when
// turned off, absent when never set.
import type { MemoryAlert } from '../domain/types.ts';

export function memoryAlertSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getMemoryAlert(): MemoryAlert | undefined;
  setMemoryAlert(alert: MemoryAlert | null): void;
} {
  return {
    getMemoryAlert() {
      const text = read('memoryAlert');
      const a = text === undefined ? null : JSON.parse(text) as MemoryAlert | null;
      return a ? { freeBytes: a.freeBytes, minutes: a.minutes } : undefined;
    },
    setMemoryAlert(alert) {
      write('memoryAlert', JSON.stringify(alert ? { freeBytes: alert.freeBytes, minutes: alert.minutes } : null));
    },
  };
}
