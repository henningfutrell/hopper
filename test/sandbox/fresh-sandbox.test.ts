// Issue #1371: a sandbox starts only on a fresh home. A check box (the read-only check, issue #716) never runs on a home
// volume that is there already — a volume of an earlier box, or one someone else made —, and never removes it. The need
// box's own case is in need-box.test.ts. The runtime is the container runtime double.
//
// Feature: a sandbox starts only on a fresh home
//   Scenario: a check box whose home volume is there already does not run, and the volume stays
//   Scenario: a check box on a fresh home runs, and its home goes after it
import { describe, expect, it } from 'vitest';
import type { Template } from '../../src/domain/vault.ts';
import { runCheck, type CheckContext } from '../../src/sandbox/check.ts';
import { probeCatalog } from '../../src/sandbox/probes.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const template: Template = {
  name: 'asked-0123456789ab', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
  readOnly: true, savedBy: 'job 1', savedAt: '2026-10-10T20:00:00.000Z',
};
const probes = probeCatalog([{ id: 'own.read', title: 'kubectl is there', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'true' }]);

const context = (runtime: ReturnType<typeof createFakeContainerRuntime>): CheckContext => ({
  runtime, instanceId: 'i-1371', network: 'hopper_default', probes,
  credentials: { credential: async () => ({ minted: { kind: 'kube', token: 'minted', expirationTimestamp: '2030-01-01T00:00:00Z' }, reach: { kind: 'kube', server: 'https://lab.example:6443' } }) },
  clock: { now: () => new Date('2026-10-15T20:00:00Z') }, logger: { info: () => {}, warn: () => {} },
});

describe('a sandbox starts only on a fresh home (issue #1371)', () => {
  it('a check box whose home volume is there already does not run, and the volume stays', async () => {
    const runtime = createFakeContainerRuntime();
    runtime.volumes.add('hopper-check-asked-1-home');
    const check = await runCheck(context(runtime), 'u1', template, 'hopper-check-asked-1');
    expect(check).toMatchObject({ state: 'failed', problem: 'the check box did not run: its home volume hopper-check-asked-1-home is there already: a sandbox starts only on a fresh home' });
    expect(runtime.ran.size).toBe(0);
    expect(runtime.volumes.has('hopper-check-asked-1-home')).toBe(true);
  });

  it('a check box on a fresh home runs, and its home goes after it', async () => {
    const runtime = createFakeContainerRuntime();
    await runCheck(context(runtime), 'u1', template, 'hopper-check-asked-2');
    expect(runtime.ran.has('hopper-check-asked-2')).toBe(true);
    expect(runtime.volumes.size).toBe(0);
    expect(runtime.boxes.size).toBe(0);
  });
});
