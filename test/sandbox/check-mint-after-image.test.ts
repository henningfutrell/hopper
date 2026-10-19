// Issue #2112: the read-only check of an EKS cluster failed on kube.get, and each write was an error, not a refusal, while
// the mint test of the same cluster passed. An EKS token works for 15 minutes from its signing. The check minted its
// credentials before it pulled the box's image and built its tools image, which can take longer than that: the box then
// signed in with a token EKS no longer takes (Unauthorized). The check now mints after the image is ready, just before the
// box is made. The pass with the runtime as a double whose one-shot boxes run the check's real script with fake tools.
//
// Feature: the read-only check mints its credentials when the box's image is ready
//   Scenario: the image is pulled and its tools image built before any credential is minted, and the box is made after
//   Scenario: an image that cannot be had fails the check, and mints no credential
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { Template } from '../../src/domain/vault.ts';
import { createCheckPass } from '../../src/sandbox/check.ts';
import { HOPPER_PROBES } from '../../src/sandbox/probes.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const fakes: FakeCloudTools[] = [];
afterEach(() => { for (const f of fakes.splice(0)) f.cleanup(); });

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const MINTED = { minted: { kind: 'kube' as const, token: 't', expirationTimestamp: '2030-01-01T00:16:00Z' }, reach: { kind: 'kube' as const, server: 'https://k' } };

function setup() {
  const cloud = createFakeCloudTools('read-only');
  fakes.push(cloud);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = (spec) => cloud.runScript(spec);
  const steps: string[] = [];
  const { pull, build, create } = runtime;
  runtime.pull = async (image) => { steps.push('pull'); return pull.call(runtime, image); };
  runtime.build = async (tag, containerfile) => { steps.push('build'); return build!.call(runtime, tag, containerfile); };
  runtime.create = async (spec) => { steps.push('create'); return create.call(runtime, spec); };
  let template: Template = {
    name: 'asked-0123456789ab', image: IMAGE, tools: ['kubectl', 'helm'], secrets: [],
    profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
    readOnly: true, savedBy: 'job j', savedAt: '2030-01-01T00:00:00.000Z',
    approval: { image: IMAGE, tools: ['kubectl', 'helm'], secrets: [], by: 'the read policy', at: '2030-01-01T00:00:01.000Z' },
  };
  const pass = createCheckPass({
    local: runtime, place: async () => ({ machine: 'local', runtime, network: 'n' }), instanceId: 'i', probes: HOPPER_PROBES,
    clock: { now: () => new Date('2030-01-01T00:01:00Z') }, logger: { info: () => {}, warn: () => {} },
    credentials: { credential: async () => { steps.push('mint'); return MINTED; } },
  }, {
    templates: () => [{ userId: 'u', template }],
    record: async (_u, _n, check: ReadOnlyCheck) => { template = { ...template, check }; },
    credential: async () => ({ refused: 'unused' }),
    report: async () => undefined,
  });
  return { pass, runtime, steps, check: () => template.check! };
}

describe('the read-only check mints its credentials when the box image is ready (issue #2112)', () => {
  it('the image is pulled and its tools image built before any credential is minted, and the box is made after', async () => {
    const s = setup();
    await s.pass();
    expect(s.steps).toEqual(expect.arrayContaining(['pull', 'build', 'mint', 'create']));
    const last = (step: string): number => s.steps.lastIndexOf(step);
    expect(last('mint'), s.steps.join(' ')).toBeGreaterThan(last('build'));
    expect(last('mint'), s.steps.join(' ')).toBeGreaterThan(last('pull'));
    expect(s.steps.indexOf('create'), s.steps.join(' ')).toBeGreaterThan(last('mint'));
    expect(s.check().state, JSON.stringify(s.check())).toBe('passed');
  });

  it('an image that cannot be had fails the check, and mints no credential', async () => {
    const s = setup();
    s.runtime.buildFails = 'podman could not build the tools image: exit status 6';
    await s.pass();
    expect(s.check()).toMatchObject({ state: 'failed', probes: [] });
    expect(s.check().problem).toContain('the check box did not run: the hopper could not build the box\'s tools image');
    expect(s.steps).not.toContain('mint');
    expect(s.steps).not.toContain('create');
  });
});
