// Issue #1349: a sandbox runs with its template's CPUs and memory. A need box and a check box take the template's
// default for each; a template that sets none gets the hopper's defaults (src/sandbox/params.ts). The runtime is the
// container runtime double, which keeps each one-shot container's spec.
//
// Feature: a sandbox runs with its template's limits
//   Scenario: a need box of a template with limits runs with the template's CPUs and memory
//   Scenario: a need box of a template with no limits runs with the hopper's defaults
//   Scenario: a check box runs with its template's CPUs and memory
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Template } from '../../src/domain/vault.ts';
import { runCheck, type CheckContext } from '../../src/sandbox/check.ts';
import { runNeedBox } from '../../src/sandbox/need-box.ts';
import { DEFAULT_LIMITS } from '../../src/sandbox/params.ts';
import { probeCatalog } from '../../src/sandbox/probes.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const limits = { cpus: { default: 1.5, max: 2 }, memoryMb: { default: 2048, max: 4096 } };

const needBox = (template: { image: string; limits?: typeof limits }) => {
  const dir = mkdtempSync(join(tmpdir(), 'limits-step-'));
  dirs.push(dir);
  return { name: 'hopper-need-asked-1-limits', userId: 'u1', instanceId: 'i1', network: 'hopper_default', template, env: {}, timeoutMs: 30_000, dir };
};
const io = () => ({ log: () => {}, signal: new AbortController().signal, pollMs: 10 });

describe('a sandbox runs with its template\'s limits (issue #1349)', () => {
  it('a need box of a template with limits runs with the template\'s CPUs and memory', async () => {
    const runtime = createFakeContainerRuntime();
    await runNeedBox(runtime, needBox({ image: 'img', limits }), io());
    expect(runtime.ran.get('hopper-need-asked-1-limits')?.limits).toEqual({ cpus: 1.5, memoryMb: 2048 });
  });

  it('a need box of a template with no limits runs with the hopper\'s defaults', async () => {
    const runtime = createFakeContainerRuntime();
    await runNeedBox(runtime, needBox({ image: 'img' }), io());
    expect(runtime.ran.get('hopper-need-asked-1-limits')?.limits).toEqual({ cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default });
  });

  it('a check box runs with its template\'s CPUs and memory', async () => {
    const runtime = createFakeContainerRuntime();
    const template: Template = {
      name: 'asked-0123456789ab', image: 'img', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }],
      readOnly: true, limits: { memoryMb: { default: 1024, max: 1024 } }, savedBy: 'job 1', savedAt: '2026-10-15T20:00:00.000Z',
    };
    const context: CheckContext = {
      runtime, instanceId: 'i1', network: 'hopper_default',
      probes: probeCatalog([{ id: 'own.read', title: 'kubectl is there', kinds: ['cluster'], tool: 'kubectl', expect: 'allowed', script: 'true' }]),
      credentials: { credential: async () => ({ minted: { kind: 'kube', token: 'minted', expirationTimestamp: '2030-01-01T00:00:00Z' }, reach: { kind: 'kube', server: 'https://lab.example:6443' } }) },
      clock: { now: () => new Date('2026-10-15T20:00:00Z') }, logger: { info: () => {}, warn: () => {} },
    };
    await runCheck(context, 'u1', template, 'hopper-check-asked-limits');
    // Only memory is set: the CPUs are the hopper's default.
    expect(runtime.ran.get('hopper-check-asked-limits')?.limits).toEqual({ cpus: DEFAULT_LIMITS.cpus.default, memoryMb: 1024 });
  });
});
