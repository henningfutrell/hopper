// The sagas of this hopper (issue #1524, design.md "Sagas: work that survives a stop"): its coordinator, which drives
// the kinds the composition root gives it — each module that moves its work onto a saga defines its kind, as the
// sandbox module does its `sandbox-step` (src/sandbox/step-saga.ts). A saga of a kind this build does not know waits
// for a hopper that does.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SagaRepository } from '../domain/sagas.ts';
import { createSagaCoordinator, type SagaCoordinator, type SagaDefinition } from './coordinator.ts';

export { createHostLeases, LEASE_ASK_MS, type HostLeases } from './leases.ts';
export { createSagaCoordinator, type SagaCoordinator, type SagaDefinition } from './coordinator.ts';

/** This process's name as a lease owner: its instance, host, pid and a nonce, so no other start takes it for its own. */
export const sagaOwner = (instanceId: string): string => `${instanceId}/${hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;

export function createSagas(o: { repo: SagaRepository; definitions: readonly SagaDefinition[]; owner: string; clock: { now(): Date }; logger: { info(line: string): void; warn(line: string): void } }): SagaCoordinator {
  return createSagaCoordinator({ repo: o.repo, definitions: o.definitions, owner: o.owner, clock: o.clock, idGen: randomUUID, logger: o.logger });
}
