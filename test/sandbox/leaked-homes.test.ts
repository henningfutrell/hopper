// Issue #1371: a sandbox leaves nothing. A home volume whose remove failed, or one a hopper that stopped mid-step left
// with no box, used to stay for good: the sweeps listed only containers. Now the need box sweep and the check box sweep
// also remove each home volume of this hopper's that no running step or check holds. A volume with no sandbox label, or
// another hopper's, stays. The runtime is the container runtime double.
//
// Feature: the sweeps remove leaked sandbox homes
//   Scenario: the check pass removes this hopper's check homes that no check holds; every other volume stays
//   Scenario: the check pass leaves the home of a check that runs now
//   Scenario: the need box sweep removes this hopper's need homes that no step holds; every other volume stays
//   Scenario: the need box sweep leaves the home of a step that runs now
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { SandboxRepository } from '../../src/domain/store.ts';
import type { Template } from '../../src/domain/vault.ts';
import { CHECK_LABEL, createCheckPass } from '../../src/sandbox/check.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { probeCatalog } from '../../src/sandbox/probes.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';

const INSTANCE = 'i-1371';
const template: Template = {
  name: 'asked-0123456789ab', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
  readOnly: true, savedBy: 'job 1', savedAt: '2026-10-10T20:00:00.000Z',
  approval: { image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], by: 'the read policy', at: '2026-10-10T20:00:01.000Z' },
};
const logger = { info: () => {}, warn: () => {} };
const clock = { now: () => new Date('2026-10-15T20:00:00Z') };

/** The volumes every sweep leaves: a stack volume, one with no label, another hopper's homes. */
async function others(r: FakeContainerRuntime): Promise<string[]> {
  await r.createVolume('hopper_pgdata', { 'com.docker.compose.project': 'hopper' });
  await r.createVolume('hopper-need-bare-home', {});
  await r.createVolume('hopper-need-far-home', { [NEED_LABEL]: 'another-hopper' });
  await r.createVolume('hopper-check-far-home', { [CHECK_LABEL]: 'another-hopper' });
  return ['hopper_pgdata', 'hopper-need-bare-home', 'hopper-need-far-home', 'hopper-check-far-home'];
}

function checkPass(r: FakeContainerRuntime, due: { now: boolean }) {
  return createCheckPass({
    local: r, place: async () => ({ machine: 'local', runtime: r, network: 'hopper_default' }), instanceId: INSTANCE, clock, logger,
    probes: probeCatalog([{ id: 'own.read', title: 'kubectl is there', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'true' }]),
    credentials: { credential: async () => ({ minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:00:00Z' }, reach: { kind: 'kube', server: 'https://k' } }) },
  }, {
    templates: () => (due.now ? [{ userId: 'u', template }] : []),
    record: async () => {}, credential: async () => ({ refused: 'unused' }), report: async () => undefined,
  });
}

function memoryRepo(): SandboxRepository {
  return { list: () => [], get: () => undefined, put: () => {}, delete: () => {} } as unknown as SandboxRepository;
}

const sandboxes = (r: FakeContainerRuntime) => createSandboxes({
  runtime: r, repo: memoryRepo(), instanceId: INSTANCE, network: 'host', joinUrl: () => 'http://hopper:1',
  mint: () => 'code', boxesOf: () => new Set(), waiting: () => new Set(), clock, logger,
});

/** A one-shot box's script that runs until `release` is called. */
function blocked(r: FakeContainerRuntime): { started: Promise<void>; release: () => void } {
  let release = (): void => {};
  let started = (): void => {};
  const s = new Promise<void>((resolve) => { started = resolve; });
  r.runScript = () => { started(); return new Promise((resolve) => { release = () => resolve({ exit: 0, output: '' }); }); };
  return { started: s, release: () => release() };
}

describe('the sweeps remove leaked sandbox homes (issue #1371)', () => {
  it('the check pass removes this hopper\'s check homes that no check holds; every other volume stays', async () => {
    const r = createFakeContainerRuntime();
    const stay = await others(r);
    await r.createVolume('hopper-check-old-home', { [CHECK_LABEL]: INSTANCE, 'io.hopper.user': 'u' });
    await checkPass(r, { now: false })();
    expect([...r.volumes].sort()).toEqual([...stay].sort());
  });

  it('the check pass leaves the home of a check that runs now', async () => {
    const r = createFakeContainerRuntime();
    const run = blocked(r);
    const due = { now: true };
    const pass = checkPass(r, due);
    const first = pass();
    await run.started;
    const [home] = [...r.volumes];
    expect(home).toMatch(/^hopper-check-asked-0123456789ab-.*-home$/);
    // A second pass sweeps while the first one's check runs.
    due.now = false;
    await pass();
    expect(r.volumes.has(home!)).toBe(true);
    run.release();
    await first;
    expect(r.volumes.size).toBe(0);
  });

  it('the need box sweep removes this hopper\'s need homes that no step holds; every other volume stays', async () => {
    const r = createFakeContainerRuntime();
    const stay = await others(r);
    await r.createVolume('hopper-need-old-home', { [NEED_LABEL]: INSTANCE, 'io.hopper.user': 'u' });
    await sandboxes(r).check();
    expect([...r.volumes].sort()).toEqual([...stay].sort());
  });

  it('the need box sweep leaves the home of a step that runs now', async () => {
    const r = createFakeContainerRuntime();
    const run = blocked(r);
    const s = sandboxes(r);
    const step = s.needStep('u', {
      name: 'hopper-need-asked-1', template: { image: template.image }, env: {}, timeoutMs: 60_000, dir: mkdtempSync(join(tmpdir(), 'need-')),
    }, { log: () => {}, signal: new AbortController().signal, pollMs: 10 });
    await run.started;
    await s.check();
    expect(r.volumes.has('hopper-need-asked-1-home')).toBe(true);
    run.release();
    expect((await step).exit).toBe(0);
    expect(r.volumes.size).toBe(0);
  });
});
