// A user runtime's history recorders: the usage history's (issue #385) and machine resources over time (issue #560),
// both pruned to the user's history retention, read at every prune so a retention set in the UI applies without a
// restart (issue #356). After a record that kept new machine samples, `afterMachineRecord` runs: lane tuning (issue #688).
// Each record shows the machines to the memory alert (issue #868) and to the Windows link watch (issue #712), which also
// takes the reports of the keep-alive loop on Windows, and to the offline watch (issue #1497), and to the drain watch (issue #2499).
import type { Clock, UserStore } from '../domain/ports.ts';
import { DEFAULT_HISTORY_RETENTION_DAYS, type MachineSnapshot, type UsageReading, type UsageSourceReport } from '../domain/types.ts';
import { createResourceRecorder, type ResourceRecorder } from '../machines/history.ts';
import { createDrainWatch } from '../machines/drain-watch.ts';
import { createMemoryWatch } from '../machines/memory-alert.ts';
import { createOfflineWatch } from '../machines/offline-watch.ts';
import { createWindowsLinkWatch, type WindowsLinkWatch } from '../machines/windows-link-watch.ts';
import { createUsageRecorder, type UsageRecorder } from '../usage/history.ts';

export function createHistoryRecorders(o: {
  readings: () => Promise<UsageReading[]>;
  sources: () => UsageSourceReport[];
  machines: () => Promise<MachineSnapshot[]>;
  afterMachineRecord?: () => Promise<unknown>;
  /** End the drains past their end (issue #2499): the engine's, so a Decision follows. */
  expireDrains?: (machineIds: readonly string[]) => void;
  store: UserStore;
  clock: Clock;
  logger: { warn(line: string): void };
}): { recorders: { usageHistory: UsageRecorder; machineHistory: ResourceRecorder }; windowsLink: WindowsLinkWatch; start(): void; stop(): void } {
  const retentionDays = () => o.store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS;
  const usageHistory = createUsageRecorder({ readings: o.readings, sources: o.sources, history: o.store.usageHistory, retentionDays, clock: o.clock, logger: o.logger });
  // The memory alert (issue #868): told on the event log, where webhooks and notifiers take it.
  const memory = createMemoryWatch({ alert: () => o.store.settings.getMemoryAlert(), tell: (e) => { o.store.events.append(e); } });
  const windowsLink = createWindowsLinkWatch({ tell: (e) => { o.store.events.append(e); } });
  const offline = createOfflineWatch({ tell: (e) => { o.store.events.append(e); } });
  const drains = createDrainWatch({
    drains: () => o.store.settings.getMachineDrains(), queued: () => o.store.jobs.list({ status: ['queued'] }), lanes: () => o.store.lanes.list(),
    expire: (ids) => { o.expireDrains?.(ids); }, tell: (e) => { o.store.events.append(e); },
  });
  const observe = (machines: readonly MachineSnapshot[], at: string) => { memory.observe(machines, at); windowsLink.observe(machines, at); offline.observe(machines, at); drains.observe(machines, at); };
  const machineHistory = createResourceRecorder({
    machines: o.machines, lanes: () => o.store.lanes.list(), history: o.store.machineHistory, retentionDays, clock: o.clock, logger: o.logger, observe,
  });
  const after = o.afterMachineRecord;
  if (after) {
    machineHistory.onRecorded(() => {
      after().catch((e: unknown) => { o.logger.warn(`hopper: after the machine samples: ${e instanceof Error ? e.message : String(e)}`); });
    });
  }
  return {
    recorders: { usageHistory, machineHistory },
    windowsLink,
    start() { usageHistory.start(); machineHistory.start(); },
    stop() { usageHistory.stop(); machineHistory.stop(); },
  };
}

export type { ResourceRecorder, UsageRecorder };
