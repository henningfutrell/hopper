// The preemption setting (issue #1525), apart from settings.ts for its size: a user's key-value setting, absent when
// never set.
import type { PreemptionSettings } from '../domain/preemption.ts';

export function preemptionSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getPreemption(): PreemptionSettings | undefined;
  setPreemption(settings: PreemptionSettings): void;
} {
  return {
    getPreemption() {
      const text = read('preemption');
      return text === undefined ? undefined : JSON.parse(text) as PreemptionSettings;
    },
    setPreemption(settings) {
      write('preemption', JSON.stringify({ enabled: settings.enabled, minRunMinutes: settings.minRunMinutes }));
    },
  };
}
