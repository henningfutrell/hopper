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
  it('is made with MemoryMax in bytes and CPUQuota in percent, in the trial run too', () => {
    const command = enterScopeCommand('j1', { memoryMaxGiB: 1.5, cpuPercent: 200 });
    expect(command.match(/-p MemoryMax=1610612736 -p CPUQuota=200%/g)).toHaveLength(2);
    expect(enterScopeCommand('j1', { cpuPercent: 50 })).not.toContain('MemoryMax');
    expect(enterScopeCommand('j1')).not.toMatch(/MemoryMax|CPUQuota/);
  });

  it('takes the limits of the lane\'s machine', async () => {
    const { herdr, executor } = setup({ scopes: true });
    await executor.run(contextFor(jobWith({ prompt: 'go' }), undefined, { ...LOCAL, jobLimits: { memoryMaxGiB: 8 } }).ctx);
    const typed = herdr.calls.filter((c) => c.method === 'runInPane').map((c) => String(c.args[1]));
    expect(typed.some((c) => c.includes('exec systemd-run --user --scope') && c.includes(`-p MemoryMax=${8 * GIB}`))).toBe(true);
  });
});
