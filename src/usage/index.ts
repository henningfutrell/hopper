import type { Clock, SettableUsageSource } from '../domain/ports.ts';
import type { UsageReading } from '../domain/types.ts';

export function createFakeUsageSource(clock: Clock): SettableUsageSource {
  const readings = new Map<string, UsageReading>();
  const copies = (): UsageReading[] => [...readings.values()].map((r) => ({ ...r }));
  readings.set('', { source: 'fake', used: 0, limit: 100, unit: '%', at: clock.now().toISOString() });
  return {
    name: 'fake',
    poll: async () => copies(),
    set(reading) {
      readings.set(reading.machineId ?? '', {
        ...reading,
        source: 'fake',
        at: clock.now().toISOString(),
      });
      return copies();
    },
  };
}
