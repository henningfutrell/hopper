// Issue #2272 part 2: a Podman host — a Linux computer with rootless Podman that a person set up for sandboxes, reached
// over ssh — as the config record `podman-hosts` keeps it: a name, an ssh destination, its pinned host key, and the most
// CPU and memory a box gets there. Not a machine: no job runs there, so the sandbox host may name it.
import { describe, expect, it } from 'vitest';
import { podmanHostsOf, podmanHostsProblem } from '../../src/domain/podman-hosts.ts';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST = { name: 'box-vm', ssh: 'sandbox@box-vm', hostKey: KEY };

describe('the podman-hosts record (issue #2272)', () => {
  it('takes a host with a label and its CPU and memory limits, and an empty list', () => {
    expect(podmanHostsProblem({ hosts: [{ ...HOST, label: 'the sandbox VM', cpus: 4, memoryMb: 8192 }] })).toBeUndefined();
    expect(podmanHostsProblem({ hosts: [] })).toBeUndefined();
  });

  it('refuses a bad name, `local`, an ssh destination with options, a host key that is not one, bad limits and a name twice', () => {
    expect(podmanHostsProblem({ hosts: [{ ...HOST, name: 'Box VM' }] })).toBe('a Podman host\'s name is lower case letters, digits and -, at most 40');
    expect(podmanHostsProblem({ hosts: [{ ...HOST, name: 'local' }] })).toBe('a Podman host is never named local: that is the runtime beside the hopper');
    expect(podmanHostsProblem({ hosts: [{ ...HOST, ssh: '-oProxyCommand=x' }] })).toBe('Podman host box-vm: ssh is a plain user@host or host');
    expect(podmanHostsProblem({ hosts: [{ ...HOST, hostKey: 'none' }] })).toBe('Podman host box-vm: hostKey is the pinned host key, <type> <base64>');
    expect(podmanHostsProblem({ hosts: [{ ...HOST, cpus: 0 }] })).toBe('Podman host box-vm: cpus is a number more than 0, at most 256');
    expect(podmanHostsProblem({ hosts: [{ ...HOST, memoryMb: 1.5 }] })).toBe('Podman host box-vm: memoryMb is a whole number more than 0, at most 1048576');
    expect(podmanHostsProblem({ hosts: [{ ...HOST, port: 22 }] })).toBe('a Podman host has no field port');
    expect(podmanHostsProblem({ hosts: [HOST, HOST] })).toBe('two Podman hosts are named box-vm');
    expect(podmanHostsProblem({ hosts: HOST })).toBe('the Podman hosts are { "hosts": [...] }');
  });

  it('reads no host from a missing or a bad record', () => {
    expect(podmanHostsOf(undefined)).toEqual([]);
    expect(podmanHostsOf({ hosts: [{ ...HOST, name: 'local' }] })).toEqual([]);
    expect(podmanHostsOf({ hosts: [HOST] })).toEqual([HOST]);
  });
});
