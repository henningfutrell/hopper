// The machine-source plugins for attached machines (issue #74, design.md "Attached machines"): `ssh`
// (an ssh target with its own herdr), `docker` (a container target, commands only) and `client` (a
// client target). Each instance is one attached machine, named after the instance; its options are
// what an `attachedMachines:` entry held. What reaches a machine — ssh, herdr, the container, the
// variable the client token is in, the pinned host key — is command-bearing (marked in the UI, edited there like any option).
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { optionsJsonSchema } from '../../src/plugins/options.ts';
import { targetOf } from '../../src/plugins/machine-source/targets.ts';
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
    expect(BUILTIN_PLUGINS.filter((p) => p.role === 'machine-source').map((p) => p.id).sort()).toEqual(['client', 'docker', 'local', 'ssh']);
  });

  it('what reaches the machine is command-bearing; lanes, executors and label are not', () => {
    expect(commandBearing('ssh')).toEqual(['herdr', 'hostKey', 'session', 'ssh', 'workTree']);
    expect(commandBearing('docker')).toEqual(['docker']);
    expect(commandBearing('client')).toEqual(['key', 'workTree']);
    expect(commandBearing('local')).toEqual(['workTree']);
  });
});

describe('disk thresholds (issue #410)', () => {
  it('are plain options of local, ssh and client, not of a container target', () => {
    for (const id of ['local', 'ssh', 'client']) {
      const props = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === id)!).properties as Record<string, unknown>;
      expect(props).toHaveProperty('diskLowBelowGiB');
      expect(props).toHaveProperty('diskLowBelowPercent');
    }
    const docker = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === 'docker')!).properties as Record<string, unknown>;
    expect(docker).not.toHaveProperty('diskLowBelowGiB');
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
    const docker = optionsJsonSchema(BUILTIN_PLUGINS.find((p) => p.id === 'docker')!).properties as Record<string, unknown>;
    expect(docker).not.toHaveProperty('reapEveryMinutes');
  });

  it('ride on the attached machine when set, and are refused out of range', () => {
    expect(targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reapEveryMinutes: 5, scratchMaxAgeHours: 2 } }))
      .toMatchObject({ sweep: { everyMinutes: 5, scratchMaxAgeHours: 2 } });
    expect(targetOf({ name: 'studio', plugin: 'client', options: { key: KEY } })).not.toHaveProperty('sweep');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reapEveryMinutes: 0 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', reapEveryMinutes: 1.5 } }))).not.toBe('accepted');
    expect(why(() => targetOf({ name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', scratchMaxAgeHours: 0 } }))).not.toBe('accepted');
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

  it('a docker instance: no herdr, the command executor by default', () => {
    expect(targetOf({ name: 'box', plugin: 'docker', options: { docker: 'hopper-target', lanes: 1 } })).toEqual({ name: 'box', docker: 'hopper-target', lanes: 1, executors: ['command'] });
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

  it('any other plugin is not an attached machine', () => {
    expect(targetOf({ name: 'local', plugin: 'local', options: { lanes: 2 } })).toBeUndefined();
  });

  it.each([
    ['ssh', { lanes: 1 }, /ssh/],
    ['ssh', { ssh: '-oProxyCommand=x', lanes: 1 }, /ssh must be a destination/],
    ['ssh', { ssh: 'laptop', lanes: 0 }, /lanes/],
    ['ssh', { ssh: 'laptop', lanes: 1, session: 'default' }, /default herdr session/],
    ['ssh', { ssh: 'laptop', lanes: 1, hostKey: 'ssh-ed25519' }, /hostKey must be a public host key/],
    ['ssh', { ssh: 'laptop', lanes: 1, docker: 'box' }, /docker/],
    // herdr is called by name there, from its PATH: no option names a binary (issue #311).
    ['ssh', { ssh: 'laptop', lanes: 1, herdrBin: '/opt/herdr' }, /herdrBin/],
    ['docker', { docker: '-H=tcp://x', lanes: 1 }, /docker must be a container/],
    ['docker', { docker: 'box', lanes: 1, herdrBin: '/opt/herdr' }, /herdrBin/],
    ['client', { lanes: 1 }, /key/],
    ['client', { key: 'short', lanes: 1 }, /key must be a machine key/],
    ['client', { key: KEY, lanes: 1, session: 'jh' }, /session/],
    ['client', { key: KEY, tokenEnv: 'T', lanes: 1 }, /tokenEnv/],
  ])('refuses %s options %j', (plugin, options, reason) => {
    expect(why(() => targetOf({ name: 'a', plugin, options }))).toMatch(reason);
  });
});
