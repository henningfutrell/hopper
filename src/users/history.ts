// A user runtime's history recorders: the usage history's (issue #385) and machine resources over time (issue #560),
// both pruned to the user's history retention, read at every prune so a retention set in the UI applies without a
// restart (issue #356). After a record that kept new machine samples, `afterMachineRecord` runs: lane tuning (issue #688).
import type { Clock, UserStore } from '../domain/ports.ts';
import { DEFAULT_HISTORY_RETENTION_DAYS, type MachineSnapshot, type UsageReading, type UsageSourceReport } from '../domain/types.ts';
import { createResourceRecorder, type ResourceRecorder } from '../machines/history.ts';
import { createUsageRecorder, type UsageRecorder } from '../usage/history.ts';

export function createHistoryRecorders(o: {
  readings: () => Promise<UsageReading[]>;
  sources: () => UsageSourceReport[];
  machines: () => Promise<MachineSnapshot[]>;
  afterMachineRecord?: () => Promise<unknown>;
  store: UserStore;
  clock: Clock;
  logger: { warn(line: string): void };
}): { recorders: { usageHistory: UsageRecorder; machineHistory: ResourceRecorder }; start(): void; stop(): void } {
  const retentionDays = () => o.store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS;
  const usageHistory = createUsageRecorder({ readings: o.readings, sources: o.sources, history: o.store.usageHistory, retentionDays, clock: o.clock, logger: o.logger });
  const machineHistory = createResourceRecorder({ machines: o.machines, lanes: () => o.store.lanes.list(), history: o.store.machineHistory, retentionDays, clock: o.clock, logger: o.logger });
  const after = o.afterMachineRecord;
  if (after) {
    machineHistory.onRecorded(() => {
      after().catch((e: unknown) => { o.logger.warn(`hopper: after the machine samples: ${e instanceof Error ? e.message : String(e)}`); });
    });
  }
  return {
    recorders: { usageHistory, machineHistory },
    start() { usageHistory.start(); machineHistory.start(); },
    stop() { usageHistory.stop(); machineHistory.stop(); },
  };
}

export type { ResourceRecorder, UsageRecorder };
