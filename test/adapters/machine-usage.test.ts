import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createLocalMachineSource } from '../../src/machines/index.ts';
import { createFakeUsageSource } from '../../src/usage/index.ts';

describe('local machine source', () => {
  it('lists one online machine with defaults', async () => {
    const src = createLocalMachineSource({ maxLanes: 4, executors: () => ['test'] });
    expect(await src.list()).toEqual([
      { id: 'local', label: hostname(), maxLanes: 4, online: true, executors: ['test'], disk: expect.objectContaining({ low: expect.any(Boolean) }) },
    ]);
  });
  it('names the executors registered when it is asked, not when it was made', async () => {
    const names = ['test'];
    const src = createLocalMachineSource({ maxLanes: 1, executors: () => names });
    names.push('scripted');
    expect((await src.list())[0]!.executors).toEqual(['test', 'scripted']);
  });
  it('carries this machine\'s work tree (issue #324)', async () => {
    const src = createLocalMachineSource({ maxLanes: 1, executors: () => [], workTree: '~/trees' });
    expect((await src.list())[0]).toMatchObject({ workTree: '~/trees' });
  });
  it('honours id and label', async () => {
    const src = createLocalMachineSource({ maxLanes: 2, executors: () => [], id: 'm1', label: 'M one', disk: () => undefined });
    expect(await src.list()).toEqual([{ id: 'm1', label: 'M one', maxLanes: 2, online: true, executors: [] }]);
  });
});

describe('fake usage source', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const clock = { now: () => at };

  it('starts with one global reading', async () => {
    const src = createFakeUsageSource(clock);
    expect(src.name).toBe('fake');
    expect(await src.poll()).toEqual([
      { source: 'fake', used: 0, limit: 100, unit: '%', at: at.toISOString() },
    ]);
  });

  it('set replaces per machine and global, stamping source and at', async () => {
    const src = createFakeUsageSource(clock);
    src.set({ used: 50, limit: 100, unit: '%' });
    src.set({ machineId: 'm1', used: 5, limit: 10, unit: 'req' });
    const all = src.set({ machineId: 'm1', used: 7, limit: 10, unit: 'req' });
    expect(all).toHaveLength(2);
    const polled = await src.poll();
    expect(polled).toEqual(expect.arrayContaining([
      { source: 'fake', used: 50, limit: 100, unit: '%', at: at.toISOString() },
      { source: 'fake', machineId: 'm1', used: 7, limit: 10, unit: 'req', at: at.toISOString() },
    ]));
  });

  it('poll returns copies', async () => {
    const src = createFakeUsageSource(clock);
    (await src.poll())[0]!.used = 99;
    expect((await src.poll())[0]!.used).toBe(0);
  });
});
