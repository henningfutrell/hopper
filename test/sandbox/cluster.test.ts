// Issue #1289: a hopper in a Kubernetes pod is given no container runtime socket, and that is no fault to fix: a need
// step says sandboxes are not started beside a hopper in a cluster, and names no socket to give it.
import { describe, expect, it } from 'vitest';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const problemOf = async (cluster: boolean): Promise<string | undefined> => {
  const sandboxes = createSandboxes({
    runtime: undefined, repo: { list: () => [], remove: () => false }, runs: memorySandboxRuns(), instanceId: 'test', network: 'host', cluster,
    clock: { now: () => new Date('2026-10-15T00:00:00.000Z') }, logger: { info() {}, warn() {} },
  });
  const r = await sandboxes.needStep('u1', { name: 'hopper-need-1', template: { image: 'img' }, env: {}, timeoutMs: 5000, dir: '.' }, { log: () => {}, signal: new AbortController().signal }, { jobId: 'job-1', step: 's1', template: 't' });
  return r.problem;
};

describe('sandboxes beside a hopper with no runtime', () => {
  it('on a host: a need step names the socket to give it', async () => {
    expect(await problemOf(false)).toContain('HOPPER_PODMAN_SOCKET');
  });

  it('in a Kubernetes pod: a need step says so, and names no socket, Podman or systemd', async () => {
    const problem = await problemOf(true);
    expect(problem).toContain('Kubernetes');
    expect(problem).not.toMatch(/socket|podman|systemctl/i);
  });
});
