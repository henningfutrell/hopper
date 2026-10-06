// Issue #189: the herdr terminal's root herdr lists every attached machine that runs herdr and that
// the hopper may reach over ssh — as a saved herdr machine whose target is the resolved destination,
// pinned by the machine's host key. Any other machine is shown with why it is not listed. Pure.
import { describe, expect, it } from 'vitest';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { herdrTerminalPlan, knownHostsLines, rootSession, sshWrapper } from '../../src/herdr-terminal/plan.ts';
import { TEST_HOST_KEY } from '../support/ssh.ts';

const ssh = (name: string, more: Partial<Extract<AttachedMachine, { ssh: string }>> = {}): AttachedMachine => ({
  name, lanes: 1, executors: ['herdr-claude'], ssh: name, herdr: true, session: 'hopper', herdrBin: '/usr/bin/herdr', hostKey: TEST_HOST_KEY, ...more,
});
const destinations: Record<string, { hostname: string; user: string; port: string }> = {
  laptop: { hostname: '192.0.2.10', user: 'me', port: '22' },
  desk: { hostname: '192.0.2.11', user: 'me', port: '2222' },
  v6: { hostname: '2001:db8::1', user: 'me', port: '22' },
};
const resolve = (target: string) => {
  const d = destinations[target];
  if (!d) throw new Error(`ssh target ${target} uses a ProxyCommand; a target is reached directly`);
  return d;
};

describe('the herdr terminal plan', () => {
  it('lists an ssh machine with herdr as a saved herdr machine on its herdr session, by its resolved destination', () => {
    const plan = herdrTerminalPlan([ssh('laptop', { label: 'Laptop' }), ssh('desk', { session: 'hopper-u2' })], resolve);
    expect(plan.profiles).toEqual([
      { machine: 'laptop', label: 'Laptop (laptop)', target: 'ssh://me@192.0.2.10:22', session: 'hopper', hostKey: TEST_HOST_KEY },
      { machine: 'desk', label: 'desk', target: 'ssh://me@192.0.2.11:2222', session: 'hopper-u2', hostKey: TEST_HOST_KEY },
    ]);
    expect(plan.machines).toEqual([{ name: 'laptop', label: 'Laptop', listed: true }, { name: 'desk', label: 'desk', listed: true }]);
  });

  it('says why a machine is not listed: no herdr, no pinned host key, a container, a client target, an ssh target it cannot resolve', () => {
    const plan = herdrTerminalPlan([
      ssh('bare', { herdr: false }),
      { ...ssh('nokey'), hostKey: undefined } as AttachedMachine,
      { name: 'box', lanes: 1, executors: ['command'], docker: 'hopper-target' },
      { name: 'studio', lanes: 1, executors: ['herdr-claude'], client: { tokenEnv: 'CLIENT_TOKEN_STUDIO' } },
      ssh('jumpy'),
    ], resolve);
    expect(plan.profiles).toEqual([]);
    expect(plan.machines.map((m) => [m.name, m.listed, m.reason])).toEqual([
      ['bare', false, 'it runs no herdr'],
      ['nokey', false, 'no host key pinned: the hopper does not connect to it'],
      ['box', false, 'a container target runs no herdr'],
      ['studio', false, 'a client target dials the hopper; the hopper has no ssh to it'],
      ['jumpy', false, 'ssh target jumpy uses a ProxyCommand; a target is reached directly'],
    ]);
  });

  it('brackets an IPv6 destination', () => {
    expect(herdrTerminalPlan([ssh('v6')], resolve).profiles[0]!.target).toBe('ssh://me@[2001:db8::1]:22');
  });

  it('pins each destination by its machine\'s host key, as ssh names a host with its port', () => {
    const plan = herdrTerminalPlan([ssh('laptop'), ssh('desk')], resolve);
    expect(knownHostsLines(plan.profiles)).toBe(`192.0.2.10 ${TEST_HOST_KEY}\n[192.0.2.11]:2222 ${TEST_HOST_KEY}\n`);
  });

  it('names the root herdr session after the user\'s herdr session', () => {
    expect(rootSession('hopper')).toBe('hopper-root');
    expect(rootSession('hopper-u2')).toBe('hopper-u2-root');
  });

  it('wraps ssh so every connection carries the hardened options, the hopper\'s key and the pins, ahead of anything herdr passes', () => {
    const text = sshWrapper({ ssh: '/usr/bin/ssh', identityFile: '/run/secrets/key', knownHostsFile: '/w/herdr-terminal/known_hosts' });
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    const line = text.split('\n').find((l) => l.startsWith('exec '))!;
    expect(line).toContain("exec '/usr/bin/ssh' -o 'BatchMode=yes'");
    for (const o of ['PasswordAuthentication=no', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'ProxyJump=none', 'ProxyCommand=none']) {
      expect(line).toContain(`-o '${o}'`);
    }
    expect(line).toContain("-i '/run/secrets/key' -o 'UserKnownHostsFile=/w/herdr-terminal/known_hosts'");
    expect(line.endsWith(' "$@"')).toBe(true);
  });
});
