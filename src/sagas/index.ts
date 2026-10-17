// The sagas of this hopper (issue #1524, design.md "Sagas: work that survives a stop"): the kinds it knows, and its
// coordinator. A kind is added here once its work moves onto a saga; a saga of a kind this build does not know waits
// for a hopper that does.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SagaRepository } from '../domain/sagas.ts';
import { createSagaCoordinator, type SagaCoordinator, type SagaDefinition } from './coordinator.ts';

export { createSagaCoordinator, type SagaCoordinator, type SagaDefinition } from './coordinator.ts';

/** The kinds of saga this build drives. */
export const SAGA_DEFINITIONS: readonly SagaDefinition[] = [];

/** This process's name as a lease owner: its instance, host, pid and a nonce, so no other start takes it for its own. */
export const sagaOwner = (instanceId: string): string => `${instanceId}/${hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;

export function createSagas(o: { repo: SagaRepository; instanceId: string; clock: { now(): Date }; logger: { info(line: string): void; warn(line: string): void } }): SagaCoordinator {
  return createSagaCoordinator({ repo: o.repo, definitions: SAGA_DEFINITIONS, owner: sagaOwner(o.instanceId), clock: o.clock, idGen: randomUUID, logger: o.logger });
}
