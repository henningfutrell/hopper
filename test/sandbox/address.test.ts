// Issue #708: the address a box beside the hopper dials, set when the box is made, never guessed later
// (src/sandbox/address.ts). The hopper reads its own container on the box's network through the runtime: a name it
// answers to there that is also one of its LAN names (the Host it accepts). The box's start check then proves it.
//
// Feature: the hopper's address for a box beside it
//   Scenario: on the host network, the box dials the hopper's loopback
//   Scenario: in a container on the box's network, the box dials the LAN name the hopper answers to there
//   Scenario: no LAN name is a name of the hopper's on that network: the launch is refused, with what to set
//   Scenario: the hopper's container is not on the box's network: the launch is refused, with the command that joins it
//   Scenario: the hopper is no container of that runtime: its first LAN name, for the start check to prove
import { describe, expect, it } from 'vitest';
import type { ContainerInfo, ContainerRuntime } from '../../src/domain/sandboxes.ts';
import { hopperAddress } from '../../src/sandbox/address.ts';
import { LaunchRefused } from '../../src/sandbox/launch.ts';

const runtimeWith = (self: ContainerInfo | undefined): ContainerRuntime & { asked: string[] } => {
  const asked: string[] = [];
  return { kind: 'podman', asked, inspect: async (id: string) => { asked.push(id); return self && (id === self.id || id === self.name) ? self : undefined; } } as unknown as ContainerRuntime & { asked: string[] };
};
const self = (networks: Record<string, string[]>): ContainerInfo => ({ id: 'a1b2c3', name: 'hopper-hopper-1', image: 'hopper', labels: {}, state: 'running', networks });
const base = { network: 'hopper_default', self: 'a1b2c3', lanNames: ['hopper.example.lan', 'hopper'], port: 4790 };

describe("the hopper's address for a box beside it", () => {
  it('on the host network, the box dials the hopper\'s loopback', async () => {
    const runtime = runtimeWith(undefined);
    expect(await hopperAddress({ ...base, runtime, network: 'host' })).toBe('http://127.0.0.1:4790');
    expect(runtime.asked).toEqual([]);
  });

  it('in a container on the box\'s network, the box dials the LAN name the hopper answers to there', async () => {
    const runtime = runtimeWith(self({ hopper_default: ['hopper', 'a1b2c3'] }));
    expect(await hopperAddress({ ...base, runtime })).toBe('http://hopper:4790');
    expect(runtime.asked).toEqual(['a1b2c3']);
  });

  it('no LAN name is a name of the hopper\'s on that network: the launch is refused, with what to set', async () => {
    const runtime = runtimeWith(self({ hopper_default: ['hopper', 'a1b2c3'] }));
    const refused = await hopperAddress({ ...base, runtime, lanNames: ['hopper.example.lan'] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LaunchRefused);
    expect((refused as LaunchRefused).status).toBe(409);
    expect((refused as Error).message).toBe('on the network hopper_default the hopper answers to hopper, a1b2c3, and HOPPER_LAN_NAMES (hopper.example.lan) names none of them: a box there could not reach it. Add hopper to HOPPER_LAN_NAMES');
  });

  it('the hopper\'s container is not on the box\'s network: the launch is refused, with the command that joins it', async () => {
    const runtime = runtimeWith(self({ podman: ['a1b2c3'] }));
    const refused = await hopperAddress({ ...base, runtime }).catch((e: unknown) => e);
    expect((refused as LaunchRefused).status).toBe(409);
    expect((refused as Error).message).toBe('the hopper\'s container is not on the network hopper_default, where a box starts: a box there could not reach it. Join it: podman network connect hopper_default hopper-hopper-1');
  });

  it('the hopper is no container of that runtime: its first LAN name, for the start check to prove', async () => {
    expect(await hopperAddress({ ...base, runtime: runtimeWith(undefined) })).toBe('http://hopper.example.lan:4790');
    expect(await hopperAddress({ ...base, runtime: runtimeWith(undefined), lanNames: [] })).toBe('http://hopper:4790');
    const runtime = runtimeWith(undefined);
    expect(await hopperAddress({ ...base, runtime, self: undefined })).toBe('http://hopper.example.lan:4790');
    expect(runtime.asked).toEqual([]);
  });
});
