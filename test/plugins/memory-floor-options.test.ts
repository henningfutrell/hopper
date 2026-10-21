// The memory floor's options (issue #2291, design.md "The memory floor"): `memoryFloorGiB` and `memoryPerJobGiB` are plain
// options of local, ssh and client, not of a container target, whose memory is not read. Set, they ride on the machine's
// snapshot as `memoryFloor`, where the decider reads them; a floor of 0 turns the floor off.
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { optionsJsonSchema } from '../../src/plugins/options.ts';
import { targetOf } from '../../src/plugins/machine-source/targets.ts';
import { createLocalMachineSource } from '../../src/machines/index.ts';

const KEY = 'k'.repeat(43);
const GIB = 1024 ** 3;

const why = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as Error).message; }
  return 'accepted';
};

describe('memory floor options (issue #2291)', () => {
  it('are plain options of local, ssh and client, not of a container target', () => {
    for (const id of ['local', 'ssh', 'client']) {
      const props = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === id)!).properties as Record<string, unknown>;
      expect(props).toHaveProperty('memoryFloorGiB');
      expect(props).toHaveProperty('memoryPerJobGiB');
    }
    const container = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === 'container')!).properties as Record<string, unknown>;
    expect(container).not.toHaveProperty('memoryFloorGiB');
  });

  it('ride on the attached machine when set, and are refused out of range', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', memoryFloorGiB: 3, memoryPerJobGiB: 4 } }))
      .toMatchObject({ memoryFloor: { floorGiB: 3, perJobGiB: 4 } });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', memoryFloorGiB: 0 } })).toMatchObject({ memoryFloor: { floorGiB: 0 } });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY } })).not.toHaveProperty('memoryFloor');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', memoryFloorGiB: -1 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', memoryPerJobGiB: 0 } }))).not.toBe('accepted');
  });

  it('this machine\'s snapshot carries them, read at every list', async () => {
    let floor: { floorGiB?: number; perJobGiB?: number } | undefined = { floorGiB: 2 };
    const src = createLocalMachineSource({
      maxLanes: 4, executors: () => ['test'], resources: () => ({ cores: 4, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB }), memoryFloor: () => floor,
    });
    expect((await src.list())[0]).toMatchObject({ memoryFloor: { floorGiB: 2 } });
    floor = undefined;
    expect((await src.list())[0]).not.toHaveProperty('memoryFloor');
  });
});
