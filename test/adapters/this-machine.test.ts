// Issue #275: an ssh target that is this machine is detected, so adding it needs no ssh. It is this
// machine when ssh would reach this host as the user the hopper runs as on ssh's own port: its
// HostName is one of this host's names, or a loopback or interface address of it, or resolves to one.
// Another user or another port (a container's published sshd) is another machine. What cannot be
// resolved is not this machine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isThisMachine } from '../../src/machines/index.ts';

const HERE = {
  user: 'me',
  names: () => ['archbox'],
  addresses: () => ['192.168.1.20', 'fe80::1', '100.64.0.7'],
  lookup: async (host: string): Promise<string[]> => {
    if (host === 'archbox.tail.example') return ['100.64.0.7'];
    if (host === 'far.example') return ['203.0.113.9'];
    throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  },
};
const at = (hostname: string, user = 'me', port = '22') => ({ ...HERE, destination: () => ({ hostname, user, port }) });

describe('isThisMachine', () => {
  it('a loopback HostName, localhost, or this host\'s own name, as the same user on port 22', async () => {
    expect(await isThisMachine('a', at('127.0.0.1'))).toBe(true);
    expect(await isThisMachine('a', at('::1'))).toBe(true);
    expect(await isThisMachine('a', at('localhost'))).toBe(true);
    expect(await isThisMachine('a', at('archbox'))).toBe(true);
    expect(await isThisMachine('a', at('ArchBox'))).toBe(true);
  });

  it('an address of this host\'s interfaces, typed or resolved', async () => {
    expect(await isThisMachine('a', at('192.168.1.20'))).toBe(true);
    expect(await isThisMachine('a', at('archbox.tail.example'))).toBe(true);
  });

  it('another host, another user or another port is another machine', async () => {
    expect(await isThisMachine('a', at('far.example'))).toBe(false);
    expect(await isThisMachine('a', at('192.0.2.10'))).toBe(false);
    expect(await isThisMachine('a', at('127.0.0.1', 'someone-else'))).toBe(false);
    expect(await isThisMachine('a', at('127.0.0.1', 'me', '2222'))).toBe(false);
  });

  it('what cannot be resolved is not this machine', async () => {
    expect(await isThisMachine('a', at('nowhere.invalid'))).toBe(false);
    expect(await isThisMachine('a', { ...HERE, destination: () => { throw new Error('ssh target a goes through a ProxyJump'); } })).toBe(false);
  });

  it('through the real ssh -G and the user\'s ~/.ssh/config (the sealed HOME)', async () => {
    mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
    writeFileSync(join(homedir(), '.ssh', 'config'), [
      'Host self-275', '  HostName 127.0.0.1', `  User ${userInfo().username}`,
      'Host other-275', '  HostName 192.0.2.10',
      'Host published-275', '  HostName 127.0.0.1', '  Port 2222',
    ].join('\n') + '\n');
    expect(await isThisMachine('self-275')).toBe(true);
    expect(await isThisMachine('other-275')).toBe(false);
    expect(await isThisMachine('published-275')).toBe(false);
  });
});
