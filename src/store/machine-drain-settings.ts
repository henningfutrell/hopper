// The drained machines (issue #1511), apart from settings.ts for its size: a user's key-value setting, by machine id; absent
// when none was ever drained.
import type { MachineDrains } from '../domain/machines.ts';

export function machineDrainSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getMachineDrains(): MachineDrains;
  setMachineDrains(drains: MachineDrains): void;
} {
  return {
    getMachineDrains() {
      const text = read('machineDrains');
      return text === undefined ? {} : JSON.parse(text) as MachineDrains;
    },
    setMachineDrains(drains) {
      write('machineDrains', JSON.stringify(Object.fromEntries(Object.entries(drains).sort(([a], [b]) => a.localeCompare(b))
        .map(([id, d]) => [id, { person: d.person, via: d.via, at: d.at }]))));
    },
  };
}
