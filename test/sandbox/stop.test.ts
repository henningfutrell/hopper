// Issue #708: the sandbox module stops only once its passes are over. A reconcile pass waits on a runtime (a machine's
// client that is away answers late); the hopper closes its database after the module stops, so a pass that went on
// after that would read and write a closed database.
//
// Feature: the sandbox module stops
//   Scenario: a reconcile pass in flight ends before stop does
//     Given the sandbox module started, its first reconcile pass waiting on the runtime's list
//     When the module is stopped
//     Then stop has not ended while the list is not answered
//     And once the list is answered, the pass ends and then stop ends
import { describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/sandboxes.ts';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

function memoryRepo(): SandboxRepository {
  const rows = new Map<string, SandboxRecord>();
  return {
    list: () => [...rows.values()],
    get: (id) => rows.get(id),
    add: (r) => (rows.has(r.id) ? false : (rows.set(r.id, r), true)),
    update: (r) => { rows.set(r.id, r); },
    remove: (id) => rows.delete(id),
  };
}

describe('the sandbox module stops', () => {
  it('a reconcile pass in flight ends before stop does', async () => {
    const runtime = createFakeContainerRuntime();
    const list = runtime.list.bind(runtime);
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    let listed = 0;
    runtime.list = async (labels) => { listed++; await answered; return list(labels); };
    const sandboxes = createSandboxes({
      runtime, repo: memoryRepo(), instanceId: 'test', network: 'host', joinUrl: () => 'http://hopper:1',
      mint: () => 'code', boxesOf: () => new Set(), waiting: () => new Set(),
      clock: { now: () => new Date('2026-10-11T00:00:00.000Z') }, logger: { info() {}, warn() {} },
    });
    sandboxes.start();
    // The reconcile pass, and (issue #1007) the sweep of need boxes no step holds: both wait on the list.
    expect(listed).toBe(2);
    let stopped = false;
    const stop = sandboxes.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    answer();
    await stop;
    expect(stopped).toBe(true);
  });
});
