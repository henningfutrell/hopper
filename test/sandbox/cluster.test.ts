// Issue #1289: a hopper in a Kubernetes pod is given no container runtime socket, and that is no fault to fix: the
// sandbox view says boxes are not started beside a hopper in a cluster, and names no socket to give it.
import { describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/sandboxes.ts';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

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

const sandboxes = (cluster: boolean) => createSandboxes({
  runtime: undefined, repo: memoryRepo(), runs: memorySandboxRuns(), instanceId: 'test', network: 'host', joinUrl: () => 'http://hopper:1', cluster,
  mint: () => 'code', boxesOf: () => new Set(), waiting: () => new Set(),
  clock: { now: () => new Date('2026-10-15T00:00:00.000Z') }, logger: { info() {}, warn() {} },
});

describe('sandbox boxes beside a hopper with no runtime', () => {
  it('on a host: the view names the socket to give it', async () => {
    const { launch } = await sandboxes(false).view('u1');
    expect(launch).toMatchObject({ available: false, problem: expect.stringContaining('HOPPER_PODMAN_SOCKET') });
  });

  it('in a Kubernetes pod: the view says so, and names no socket, Podman or systemd', async () => {
    const { launch } = await sandboxes(true).view('u1');
    expect(launch).toMatchObject({ available: false, problem: expect.stringContaining('Kubernetes') });
    expect(launch.problem).not.toMatch(/socket|podman|systemctl/i);
  });
});
