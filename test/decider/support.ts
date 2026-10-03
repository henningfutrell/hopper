import type {
  DecisionInputs, DeciderPolicy, Job, AdviceAction, Advice, Lane, MachineSnapshot, UsageReading,
} from '../../src/domain/types.ts';

export const NOW = '2026-10-02T12:00:00.000Z';

export const policy: DeciderPolicy = {
  softLimit: 0.7, hardLimit: 0.95, routerCheapBoost: 10, laneIdleGraceMs: 5000, resumeBoost: 20,
};

export function machine(over: Partial<MachineSnapshot> = {}): MachineSnapshot {
  return { id: 'local', label: 'local', maxLanes: 4, online: true, executors: ['test'], ...over };
}

export function advice(action: AdviceAction): Advice {
  return { action, reason: `because ${action}`, details: {}, source: 'fake', at: NOW };
}

export function job(id: string, over: Partial<Job> & { executor?: string; machineId?: string } = {}): Job {
  const { executor, machineId, ...rest } = over;
  return {
    id,
    spec: { executor: executor ?? 'test', payload: {}, ...(machineId ? { machineId } : {}) },
    priority: 50, status: 'queued', approved: false, attempts: 0,
    createdAt: '2026-10-02T11:00:00.000Z', updatedAt: '2026-10-02T11:00:00.000Z',
    ...rest,
  };
}

export function lane(n: number, over: Partial<Lane> & { machineId?: string } = {}): Lane {
  const machineId = over.machineId ?? 'local';
  return {
    id: `${machineId}/lane-${n}`, machineId, state: 'idle',
    openedAt: `2026-10-02T10:0${n}:00.000Z`, idleSince: '2026-10-02T11:00:00.000Z', ...over,
  };
}

export function busy(n: number, jobId: string, over: Partial<Lane> & { machineId?: string } = {}): Lane {
  return lane(n, { state: 'busy', jobId, idleSince: undefined, ...over });
}

export function reading(used: number, limit = 100, over: Partial<UsageReading> = {}): UsageReading {
  return { source: 'fake', used, limit, unit: 'tokens', at: NOW, ...over };
}

export function inputs(over: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    at: NOW, trigger: 'tick', routerMode: 'shadow', machines: [machine()], lanes: [], usage: [],
    waiting: [], running: [], policy, ...over,
  };
}
