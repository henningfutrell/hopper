// A job's memory and CPU limits (issue #2498, design.md "The job's scope"): `jobMemoryMaxGiB` and `jobCpuPercent` are plain
// options of local, ssh and client, not of a container target. Set, they ride on the machine's snapshot as `jobLimits`, and
// the job's scope is made with them (`MemoryMax`, `CPUQuota`): a job past its memory limit is stopped by the OOM killer in
// its own scope, not the machine's other work.
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { optionsJsonSchema } from '../../src/plugins/options.ts';
import { targetOf } from '../../src/plugins/machine-source/targets.ts';
import { createLocalMachineSource } from '../../src/machines/index.ts';
import { enterScopeCommand } from '../../src/executors/herdr/job-scope.ts';
import { scopeLimitsOf } from '../../src/domain/job-limits.ts';
import { turnCommand } from '../../src/executors/print-agent.ts';
import { LOCAL, contextFor, jobWith, setup } from '../herdr/support.ts';

const GIB = 1024 ** 3;

const why = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as Error).message; }
  return 'accepted';
};

describe('job limit options', () => {
  it('are plain options of local, ssh and client, not of a container target', () => {
    for (const id of ['local', 'ssh', 'client']) {
      const props = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === id)!).properties as Record<string, unknown>;
      expect(props).toHaveProperty('jobMemoryMaxGiB');
      expect(props).toHaveProperty('jobCpuPercent');
    }
    const container = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === 'container')!).properties as Record<string, unknown>;
    expect(container).not.toHaveProperty('jobMemoryMaxGiB');
  });

  it('ride on the attached machine when set, and are refused out of range', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', jobMemoryMaxGiB: 6, jobCpuPercent: 200 } }))
      .toMatchObject({ jobLimits: { memoryMaxGiB: 6, cpuPercent: 200 } });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop' } })).not.toHaveProperty('jobLimits');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', jobMemoryMaxGiB: 0 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', jobCpuPercent: 0 } }))).not.toBe('accepted');
  });

  it('this machine\'s snapshot carries them, read at every list', async () => {
    let limits: { memoryMaxGiB?: number; cpuPercent?: number } | undefined = { memoryMaxGiB: 4 };
    const src = createLocalMachineSource({
      maxLanes: 4, executors: () => ['test'], resources: () => ({ cores: 4, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB }), jobLimits: () => limits,
    });
    expect((await src.list())[0]).toMatchObject({ jobLimits: { memoryMaxGiB: 4 } });
    limits = undefined;
    expect((await src.list())[0]).not.toHaveProperty('jobLimits');
  });
});

describe('the job\'s scope with limits', () => {
  // Issue #2622: MemoryHigh at 90% of MemoryMax, so the kernel reclaims and slows the job before the OOM killer stops it.
  it('is made with MemoryMax and MemoryHigh in bytes and CPUQuota in percent, in the trial run too', () => {
    const command = enterScopeCommand('j1', { memoryMaxGiB: 1.5, cpuPercent: 200 });
    expect(command.match(/-p MemoryMax=1610612736 -p MemoryHigh=1449551462 -p CPUQuota=200%/g)).toHaveLength(2);
    expect(enterScopeCommand('j1', { cpuPercent: 50 })).not.toContain('MemoryMax');
    expect(enterScopeCommand('j1')).not.toMatch(/MemoryMax|CPUQuota/);
  });

  it('takes the limits of the lane\'s machine', async () => {
    const { herdr, executor } = setup({ scopes: true });
    await executor.run(contextFor(jobWith({ prompt: 'go' }), undefined, { ...LOCAL, jobLimits: { memoryMaxGiB: 8 } }).ctx);
    const typed = herdr.calls.filter((c) => c.method === 'runInPane').map((c) => String(c.args[1]));
    expect(typed.some((c) => c.includes('exec systemd-run --user --scope') && c.includes(`-p MemoryMax=${8 * GIB}`))).toBe(true);
  });

  it('with no job limits set, takes the default ones of the lane\'s machine (issue #2622)', async () => {
    const { herdr, executor } = setup({ scopes: true });
    const resources = { cores: 4, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB };
    await executor.run(contextFor(jobWith({ prompt: 'go' }), undefined, { ...LOCAL, maxLanes: 4, resources }).ctx);
    const typed = herdr.calls.filter((c) => c.method === 'runInPane').map((c) => String(c.args[1]));
    expect(typed.some((c) => c.includes('exec systemd-run --user --scope') && c.includes(`-p MemoryMax=${Math.round(3.6 * GIB)}`))).toBe(true);
  });

  it('a print agent\'s turn is made with them too, in the trial run too (issue #2622)', () => {
    const command = turnCommand('j1', 'claude -p', { memoryMaxGiB: 2 });
    expect(command.match(new RegExp(`-p MemoryMax=${2 * GIB} -p MemoryHigh=${Math.round(1.8 * GIB)}`, 'g'))).toHaveLength(2);
    expect(turnCommand('j1', 'claude -p')).not.toContain('MemoryMax');
  });
});

// Issue #2622: a job with no limit could take the whole host. With no `jobMemoryMaxGiB`, each job's scope gets the
// machine's memory less its memory floor, shared by its lanes, and never less than a job's memory.
describe('the default job limits (issue #2622)', () => {
  const machine = (o: Record<string, unknown> = {}) => ({ ...LOCAL, maxLanes: 4, resources: { cores: 4, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB }, ...o });

  it('are the machine\'s memory less its default floor, shared by its lanes', () => {
    expect(scopeLimitsOf(machine())).toEqual({ memoryMaxGiB: 3.6 });
    expect(scopeLimitsOf(machine({ resources: { cores: 4, memTotalBytes: 8 * GIB, memAvailableBytes: 8 * GIB }, maxLanes: 1 }))).toEqual({ memoryMaxGiB: 7 });
  });

  it('take the machine\'s own floor, and keep its CPU limit', () => {
    expect(scopeLimitsOf(machine({ memoryFloor: { floorGiB: 4 }, jobLimits: { cpuPercent: 200 } }))).toEqual({ memoryMaxGiB: 3, cpuPercent: 200 });
  });

  it('are never below a job\'s memory', () => {
    expect(scopeLimitsOf(machine({ resources: { cores: 4, memTotalBytes: 4 * GIB, memAvailableBytes: 2 * GIB } }))).toEqual({ memoryMaxGiB: 2 });
    expect(scopeLimitsOf(machine({ resources: { cores: 4, memTotalBytes: 4 * GIB, memAvailableBytes: 2 * GIB }, memoryFloor: { perJobGiB: 3 } }))).toEqual({ memoryMaxGiB: 3 });
  });

  it('give way to its jobMemoryMaxGiB', () => {
    expect(scopeLimitsOf(machine({ jobLimits: { memoryMaxGiB: 6, cpuPercent: 100 } }))).toEqual({ memoryMaxGiB: 6, cpuPercent: 100 });
  });

  it('set no memory limit with no memory reading or no lanes', () => {
    expect(scopeLimitsOf(machine({ resources: undefined }))).toBeUndefined();
    expect(scopeLimitsOf(machine({ resources: undefined, jobLimits: { cpuPercent: 50 } }))).toEqual({ cpuPercent: 50 });
    expect(scopeLimitsOf(machine({ maxLanes: 0 }))).toBeUndefined();
  });
});
