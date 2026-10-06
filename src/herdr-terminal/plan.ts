// Which attached machines the root herdr lists, and how it reaches them (issue #189, design.md "The
// herdr terminal"). Pure: the ssh destination is resolved by the caller. A machine is listed when it
// runs herdr, is an ssh target, and has a pinned host key — exactly the machines the hopper itself
// reaches over ssh. Its saved herdr machine targets the resolved destination (`ssh://user@host:port`),
// so no ssh config decides where it goes, and its host is pinned by the machine's host key.
import type { AttachedMachine, HerdrMachineProfile, HerdrTerminalMachine } from '../domain/types.ts';
import { HARDENED_SSH_OPTIONS } from '../client/ssh-options.ts';
import { shellQuote } from '../executors/ssh.ts';

export interface Destination { hostname: string; user: string; port: string }

export interface HerdrTerminalPlan { profiles: HerdrMachineProfile[]; machines: HerdrTerminalMachine[] }

/** The root herdr session: the user's herdr session, `-root`. */
export const rootSession = (userSession: string): string => `${userSession}-root`;

const host = (hostname: string): string => (hostname.includes(':') ? `[${hostname}]` : hostname);

export function herdrTerminalPlan(machines: readonly AttachedMachine[], resolve: (target: string) => Destination): HerdrTerminalPlan {
  const profiles: HerdrMachineProfile[] = [];
  const shown: HerdrTerminalMachine[] = [];
  for (const m of machines) {
    const label = m.label ?? m.name;
    const skip = (reason: string) => shown.push({ name: m.name, label, listed: false, reason });
    if ('docker' in m) { skip('a container target runs no herdr'); continue; }
    if ('client' in m) { skip('a client target dials the hopper; the hopper has no ssh to it'); continue; }
    if (!m.herdr) { skip('it runs no herdr'); continue; }
    if (!m.hostKey) { skip('no host key pinned: the hopper does not connect to it'); continue; }
    let d: Destination;
    try {
      d = resolve(m.ssh);
    } catch (e) {
      skip((e as Error).message);
      continue;
    }
    profiles.push({
      machine: m.name, label: label === m.name ? m.name : `${label} (${m.name})`,
      target: `ssh://${d.user}@${host(d.hostname)}:${d.port}`, session: m.session, hostKey: m.hostKey,
    });
    shown.push({ name: m.name, label, listed: true });
  }
  return { profiles, machines: shown };
}

/** known_hosts lines pinning each destination by its machine's host key, named as ssh names a host and port. */
export function knownHostsLines(profiles: readonly HerdrMachineProfile[]): string {
  return profiles.map((p) => {
    const u = new URL(p.target);
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const name = u.port === '22' || u.port === '' ? hostname : `[${hostname}]:${u.port}`;
    return `${name} ${p.hostKey}\n`;
  }).join('');
}

/**
 * The `ssh` the root herdr runs: the real ssh with the hardened options, the hopper's key and the pins
 * on its command line, ahead of whatever herdr passes — on the command line, so they beat any config
 * herdr or the user's ~/.ssh/config gives. No jump host, no proxy command.
 */
export function sshWrapper(o: { ssh: string; identityFile: string; knownHostsFile: string }): string {
  const options = [...HARDENED_SSH_OPTIONS, 'ProxyJump=none', 'ProxyCommand=none'].flatMap((x) => ['-o', shellQuote(x)]);
  return [
    '#!/bin/sh',
    '# Written by the hopper for its herdr terminal (design.md "The herdr terminal"). Rewritten on every open.',
    `exec ${[shellQuote(o.ssh), ...options, '-i', shellQuote(o.identityFile), '-o', shellQuote(`UserKnownHostsFile=${o.knownHostsFile}`)].join(' ')} "$@"`,
    '',
  ].join('\n');
}
