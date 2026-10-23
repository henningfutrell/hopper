// The machine-source plugins for attached machines (issue #74, design.md "Attached machines"): `ssh`
// (an ssh target with its own herdr), `docker` (a container target, commands only) and `client` (a
// client target). Each instance is one attached machine, named after the instance; its options are
// what an `attachedMachines:` entry held. What reaches a machine — ssh, herdr, the container, the
// variable the client token is in, the pinned host key — is command-bearing (marked in the UI, edited there like any option).
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { optionsJsonSchema } from '../../src/plugins/options.ts';
import { targetOf } from '../../src/plugins/machine-source/targets.ts';
import { CONTAINER_IMAGE } from '../../src/plugins/machine-source/container/index.ts';
import { TEST_HOST_KEY } from '../support/ssh.ts';

/** A machine key: the public half of a link key (issue #308). */
const KEY = 'k'.repeat(43);

const commandBearing = (id: string): string[] => {
  const def = BUILTIN_PLUGINS.find((p) => p.id === id)!;
  const props = optionsJsonSchema(def).properties as Record<string, { commandBearing?: boolean }>;
  return Object.entries(props).filter(([, p]) => p.commandBearing).map(([k]) => k).sort();
};

const why = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as Error).message; }
  return 'accepted';
};

describe('the attached-machine plugins', () => {
  it('are built-in machine-source plugins named by their connection', () => {
    expect(BUILTIN_PLUGINS.filter((p) => p.role === 'machine-source').map((p) => p.id).sort()).toEqual(['client', 'container', 'kubernetes-cluster', 'local', 'ssh']);
  });

  it('what reaches the machine, what of the vault it may be given (its template, issue #558), the job pod the hopper started for it (issue #1283) and whether it is a lane pod (issue #1284) are command-bearing; lanes, executors and label are not', () => {
    expect(commandBearing('ssh')).toEqual(['herdr', 'hostKey', 'session', 'ssh', 'workTree', 'workTrees']);
    expect(commandBearing('container')).toEqual(['image']);
    expect(commandBearing('client')).toEqual(['key', 'pod', 'pool', 'template', 'workTree', 'workTrees']);
    expect(commandBearing('local')).toEqual(['workTree', 'workTrees']);
  });
});

describe('disk thresholds (issue #410)', () => {
  it('are plain options of local, ssh and client, not of a container target', () => {
    for (const id of ['local', 'ssh', 'client']) {
      const props = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === id)!).properties as Record<string, unknown>;
      expect(props).toHaveProperty('diskLowBelowGiB');
      expect(props).toHaveProperty('diskLowBelowPercent');
    }
    const container = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === 'container')!).properties as Record<string, unknown>;
    expect(container).not.toHaveProperty('diskLowBelowGiB');
  });

  it('ride on the attached machine when set, and are refused out of range', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', diskLowBelowGiB: 20, diskLowBelowPercent: 15 } }))
      .toMatchObject({ diskLow: { belowGiB: 20, belowPercent: 15 } });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY } })).not.toHaveProperty('diskLow');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', diskLowBelowPercent: 120 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', diskLowBelowGiB: 0 } }))).not.toBe('accepted');
  });
});

describe('sweep settings (issue #410)', () => {
  it('are plain options of local, ssh and client, not of a container target', () => {
    for (const id of ['local', 'ssh', 'client']) {
      const props = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === id)!).properties as Record<string, unknown>;
      expect(props).toHaveProperty('reapEveryMinutes');
      expect(props).toHaveProperty('scratchMaxAgeHours');
    }
    const container = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === 'container')!).properties as Record<string, unknown>;
    expect(container).not.toHaveProperty('reapEveryMinutes');
  });

  it('ride on the attached machine when set, and are refused out of range', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reapEveryMinutes: 5, scratchMaxAgeHours: 2 } }))
      .toMatchObject({ sweep: { everyMinutes: 5, scratchMaxAgeHours: 2 } });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY } })).not.toHaveProperty('sweep');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reapEveryMinutes: 0 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reapEveryMinutes: 1.5 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', scratchMaxAgeHours: 0 } }))).not.toBe('accepted');
  });

  it('the retention per job status (issue #2494) rides on the sweep settings; 0 is allowed, a negative is refused', () => {
    for (const id of ['local', 'ssh', 'client']) {
      const props = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === id)!).properties as Record<string, unknown>;
      for (const k of ['retainFinishedHours', 'retainFailedHours', 'retainCancelledHours', 'retainRejectedHours']) expect(props).toHaveProperty(k);
    }
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', retainFailedHours: 48, retainFinishedHours: 0 } }))
      .toMatchObject({ sweep: { retainHours: { failed: 48, finished: 0 } } });
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', retainCancelledHours: -1 } }))).not.toBe('accepted');
  });
});

describe('targetOf: an instance as the attached machine it names', () => {
  it('an ssh instance, with its defaults', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 2 } })).toEqual({
      name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], herdr: true, session: 'hopper',
    });
    expect(targetOf({ name: 'pi', plugin: 'ssh', options: { ssh: 'user@pi.example', label: 'Pi', lanes: 1, executors: ['herdr-claude', 'other'], session: 'jh', hostKey: TEST_HOST_KEY } })).toEqual({
      name: 'pi', ssh: 'user@pi.example', label: 'Pi', lanes: 1, executors: ['herdr-claude', 'other'], herdr: true, session: 'jh', hostKey: TEST_HOST_KEY,
    });
  });

  it('an ssh instance that runs no herdr (issue #142): Cursor or commands over ssh', () => {
    expect(targetOf({ name: 'wsl', plugin: 'ssh', options: { ssh: 'wsl', lanes: 1, executors: ['cursor'], herdr: false } })).toMatchObject({ name: 'wsl', ssh: 'wsl', executors: ['cursor'], herdr: false });
  });

  it('a container instance (issue #865): no herdr, the command executor by default, the hopper\'s box image when it names none', () => {
    expect(targetOf({ name: 'box', plugin: 'container', options: { image: 'example/box:1', lanes: 1 } })).toEqual({ name: 'box', image: 'example/box:1', lanes: 1, executors: ['command'] });
    expect(targetOf({ name: 'box', plugin: 'container', options: {} })).toMatchObject({ image: CONTAINER_IMAGE });
  });

  // Issue #365: 0 lanes rests a machine; it stays one, so a client target still dials in and shows online.
  it('an attached instance with 0 lanes is still an attached machine', () => {
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, lanes: 0 } })).toMatchObject({ name: 'studio', client: { key: KEY }, lanes: 0 });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 0 } })).toMatchObject({ name: 'laptop', lanes: 0 });
  });

  it('a client instance names its machine key (issue #308); herdr-claude runs there by default', () => {
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, lanes: 2 } })).toEqual({
      name: 'studio', client: { key: KEY }, lanes: 2, executors: ['herdr-claude'],
    });
  });

  // Issue #324: a machine's own default work tree, resolved there.
  it('an ssh or client instance carries its work tree; a relative one is refused', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', workTree: '~/trees' } })).toMatchObject({ workTree: '~/trees' });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, workTree: '/srv/trees' } })).toMatchObject({ workTree: '/srv/trees' });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop' } })).not.toHaveProperty('workTree');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', workTree: 'trees' } }))).toMatch(/workTree must be an absolute path or start with ~/);
  });

  // Issue #691: a work tree per repository, so a job works in its own repository's tree on the machine.
  it('an ssh or client instance carries a work tree per repository; a key that is no owner/name or a relative path is refused', () => {
    const workTrees = { 'acme/monolith': '~/wt/monolith', 'acme/platform': '/srv/platform' };
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', workTrees } })).toMatchObject({ workTrees });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, workTrees } })).toMatchObject({ workTrees });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop' } })).not.toHaveProperty('workTrees');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', workTrees: { monolith: '~/wt' } } }))).toMatch(/owner\/name/);
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', workTrees: { 'acme/monolith': 'wt' } } }))).toMatch(/absolute path or start with ~/);
    expect(why(() => targetOf({ name: 'box', plugin: 'container', options: { workTrees } }))).not.toBe('accepted');
  });

  // Issue #1860: a machine's own usage limits, so one of two machines on one account gives way first.
  it('an attached instance carries its own usage limits; soft at or above hard is refused', () => {
    expect(targetOf({ name: 'seat', plugin: 'ssh', options: { ssh: 'seat', usageLimits: { soft: 0.5, hard: 0.7 } } })).toMatchObject({ usageLimits: { soft: 0.5, hard: 0.7 } });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, usageLimits: { soft: 0.4, hard: 0.6 } } })).toMatchObject({ usageLimits: { soft: 0.4, hard: 0.6 } });
    expect(targetOf({ name: 'seat', plugin: 'ssh', options: { ssh: 'seat' } })).not.toHaveProperty('usageLimits');
    expect(why(() => targetOf({ name: 'seat', plugin: 'ssh', options: { ssh: 'seat', usageLimits: { soft: 0.7, hard: 0.7 } } }))).toMatch(/soft must be below hard/);
    expect(why(() => targetOf({ name: 'seat', plugin: 'ssh', options: { ssh: 'seat', usageLimits: { soft: 0.5, hard: 1.5 } } }))).toMatch(/usageLimits/);
  });

  // Issue #372: lanes kept for jobs pinned to the machine.
  it('an attached instance carries its reserved lanes; a negative count is refused', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 4, reservedLanes: 1 } })).toMatchObject({ lanes: 4, reservedLanes: 1 });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, reservedLanes: 2 } })).toMatchObject({ reservedLanes: 2 });
    expect(targetOf({ name: 'box', plugin: 'container', options: { reservedLanes: 1 } })).toMatchObject({ reservedLanes: 1 });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop' } })).not.toHaveProperty('reservedLanes');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reservedLanes: -1 } }))).toMatch(/reservedLanes/);
  });

  // Issue #1350: a Windows machine takes the jobs labelled hopper:win or hopper:windows, and only it does.
  it('an attached instance says it is a Windows machine; absent, it is not', () => {
    expect(targetOf({ name: 'win', plugin: 'ssh', options: { ssh: 'win', windows: true } })).toMatchObject({ windows: true });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY, windows: true } })).toMatchObject({ windows: true });
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop' } })).not.toHaveProperty('windows');
    expect(why(() => targetOf({ name: 'win', plugin: 'ssh', options: { ssh: 'win', windows: 'yes' } }))).toMatch(/windows/);
  });

  it('any other plugin is not an attached machine', () => {
    expect(targetOf({ name: 'local', plugin: 'local', options: { lanes: 2 } })).toBeUndefined();
  });

  it.each([
    ['ssh', { lanes: 1 }, /ssh/],
    ['ssh', { ssh: '-oProxyCommand=x', lanes: 1 }, /ssh must be a destination/],
    ['ssh', { ssh: 'laptop', lanes: -1 }, /lanes/],
    ['ssh', { ssh: 'laptop', lanes: 1, session: 'default' }, /default herdr session/],
    ['ssh', { ssh: 'laptop', lanes: 1, hostKey: 'ssh-ed25519' }, /hostKey must be a public host key/],
    ['ssh', { ssh: 'laptop', lanes: 1, docker: 'box' }, /docker/],
    // herdr is called by name there, from its PATH: no option names a binary (issue #311).
    ['ssh', { ssh: 'laptop', lanes: 1, herdrBin: '/opt/herdr' }, /herdrBin/],
    ['container', { image: '--privileged', lanes: 1 }, /image must be an image/],
    ['container', { image: 'box', lanes: 1, herdrBin: '/opt/herdr' }, /herdrBin/],
    ['container', { docker: 'box', lanes: 1 }, /docker/],
    ['client', { lanes: 1 }, /key/],
    ['client', { key: 'short', lanes: 1 }, /key must be a machine key/],
    ['client', { key: KEY, lanes: 1, session: 'jh' }, /session/],
    ['client', { key: KEY, tokenEnv: 'T', lanes: 1 }, /tokenEnv/],
  ])('refuses %s options %j', (plugin, options, reason) => {
    expect(why(() => targetOf({ name: 'a', plugin, options }))).toMatch(reason);
  });
});
