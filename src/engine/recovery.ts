// Restart recovery (design.md "The engine"): interrupted jobs return to the queue,
// every stored lane closes.
import type { Store } from '../domain/ports.ts';

export function recover(store: Store): void {
  store.tx(() => {
    for (const job of store.jobs.list({ status: ['claimed', 'running'] })) {
      store.jobs.update(job.id, {
        status: 'queued', laneId: undefined, holdReason: undefined, progress: undefined, progressMessage: undefined,
      });
      store.events.append({ type: 'job.requeued', jobId: job.id, data: { from: job.status, reason: 'daemon restart' } });
    }
    for (const lane of store.lanes.list()) {
      store.lanes.close(lane.id);
      store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'daemon restart' } });
    }
  });
}
