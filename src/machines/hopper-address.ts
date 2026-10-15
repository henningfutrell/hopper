// Where a job on a machine reaches the hopper (issue #698, design.md "GitHub through the hopper"): its HOPPER_URL, for
// hopper-gh, git through the hopper, skills and artifacts. An ssh target was given the first LAN name, which only the
// hopper's compose network resolved: the job could not reach the hopper and fell back to a device sign-in. So an ssh
// target's probe asks the machine itself which of the hopper's addresses it reaches (`addressCommand`, at the address path),
// and a job there is given that one; when it reaches none, the machine has an **address problem** and takes no new job.
import type { MachineSnapshot } from '../domain/types.ts';
import { shellQuote } from '../executors/ssh.ts';
import { defaultHostLinkBase } from '../artifacts/links.ts';

/** The route a machine's probe asks at each address: 204 and nothing else, from the hopper, behind the Host guard. */
export const ADDRESS_PATH = '/job/address';

/** What the address check prints, one line per address it asked, or that the machine has no curl. */
const LINE = 'hopper-address';
const NO_CURL = `${LINE} no-curl`;

/** Whether a line of a probe's output is the address check's. */
export const isAddressLine = (line: string): boolean => line.startsWith(`${LINE} `);

const SET_ADDRESS = 'set HOPPER_PUBLIC_URL to an address it reaches, or add a name it resolves to HOPPER_LAN_NAMES';

/** A container's name: no dot, so not a host name, not an address. */
const CONTAINER = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/**
 * The command that joins a machine off the hopper's network to it (issue #711), or undefined: the hopper is on no
 * network of its own (`host`), or the ssh target's host is not a container's name (a host name, an address,
 * `localhost`). An ssh target named by its container, a seat for one, is on the hopper's network once connected, and
 * resolves the hopper by name there.
 */
export function networkFix(ssh: string, network: string | undefined): string | undefined {
  if (network === undefined || network === 'host') return undefined;
  const host = ssh.slice(ssh.indexOf('@') + 1);
  return CONTAINER.test(host) && host !== 'localhost' ? `podman network connect ${network} ${host}` : undefined;
}

/** The hopper's addresses a machine may reach it at, in order: the public URL, then each LAN name with the port. */
export function hopperAddresses(o: { publicUrl?: string | undefined; lanNames: readonly string[]; port: number }): string[] {
  return [...(o.publicUrl ? [o.publicUrl.replace(/\/+$/, '')] : []), ...o.lanNames.map((n) => `http://${n}:${o.port}`)];
}

/**
 * The address a WSL machine on the computer that runs the hopper reaches it at (issue #1248 part 4), or undefined: the
 * hopper does not run in WSL. WSL distros on one computer share one network, and the hopper publishes its port on
 * loopback there, so it is the hopper's host link (issue #712): the host link base, else `http://localhost:<port>`.
 */
export function wslHopperUrl(o: { wsl: boolean; hostLinkBase: string; port: number }): string | undefined {
  if (!o.wsl) return undefined;
  return o.hostLinkBase.replace(/\/+$/, '') || defaultHostLinkBase(o.port);
}

/** What a WSL machine is asked (issue #1248 part 4): the address on the hopper's computer, and the kernel file that says WSL. */
export interface WslAddress { url: string; procVersion?: string }

/** One address asked: `hopper-address <status> <url>` (000: no connection), at most 3 s. */
const ASK = `c=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "$u${ADDRESS_PATH}"); printf '${LINE} %s %s\\n' "\${c:-000}" "$u"`;

/**
 * The shell that asks the address path at each address, in order, until one answers 204: one line per address asked.
 * Then, when none did and the machine runs in WSL (its kernel file names Microsoft), the address `wsl` names. Nothing to
 * ask: nothing runs.
 */
export function addressCommand(urls: readonly string[], wsl?: WslAddress): string {
  if (urls.length === 0 && !wsl) return ':';
  const each = urls.length ? `for u in ${urls.map(shellQuote).join(' ')}; do ${ASK}; if [ "$c" = 204 ]; then break; fi; done;` : '';
  const onWsl = wsl ? ` if [ "$c" != 204 ] && grep -qi microsoft ${shellQuote(wsl.procVersion ?? '/proc/version')} 2>/dev/null; then u=${shellQuote(wsl.url)}; ${ASK}; fi;` : '';
  return `if command -v curl >/dev/null 2>&1; then c=; ${each}${onWsl} else echo '${NO_CURL}'; fi`;
}

const why = (status: string): string => {
  if (status === '000') return 'no connection';
  if (status === '403') return 'refused: its address is not in HOPPER_LAN_PEERS';
  if (status === '421') return 'refused: the hopper does not answer to that name';
  return `answered ${status}, not as the hopper`;
};

/**
 * What the address check found: the first address that answered as the hopper, or why none did. `wsl`, the address a
 * WSL machine was asked after the others (issue #1248 part 4): asked, it was a WSL machine, and the problem names it.
 */
export function readAddress(stdout: string, urls: readonly string[], wsl?: string): { hopperUrl: string } | { addressProblem: string } {
  const lines = stdout.split('\n').filter(isAddressLine);
  if (lines.includes(NO_CURL)) return { addressProblem: 'curl is not installed there: its jobs cannot reach the hopper' };
  const asked = new Map<string, string>();
  for (const l of lines) {
    const [, status, ...rest] = l.split(' ');
    asked.set(rest.join(' '), status ?? '');
  }
  const reached = urls.find((u) => asked.get(u) === '204');
  if (reached) return { hopperUrl: reached };
  if (wsl !== undefined && asked.get(wsl) === '204') return { hopperUrl: wsl };
  const onWsl = wsl !== undefined && asked.has(wsl)
    ? `a WSL machine on the computer that runs the hopper reaches it at ${wsl}, and this one did not (${why(asked.get(wsl)!)}). `
    : '';
  if (urls.length === 0) return { addressProblem: `${onWsl}the hopper has no address a machine can reach it at: set HOPPER_PUBLIC_URL, or HOPPER_LAN_NAMES with names machines resolve` };
  const said = urls.map((u) => `${u} (${asked.has(u) ? why(asked.get(u)!) : 'not asked'})`).join('; ');
  return { addressProblem: `the hopper cannot be reached from it: ${said}. ${onWsl}Its jobs need the hopper: ${SET_ADDRESS}` };
}

/**
 * The hopper's URL as a job on `m` reaches it, or undefined: it cannot, and its jobs get no proxy. A client target, the
 * URL it dialled in at; an ssh target, the address its probe found it reaches, never one it was not seen to reach; a
 * container target, the public URL, else the first LAN name; this machine, loopback.
 */
export function jobHopperUrl(m: MachineSnapshot, dialled: string | undefined, o: { port: number; reachable: string | undefined }): string | undefined {
  if (dialled) return dialled;
  if (m.client) return o.reachable;
  if (m.ssh) return m.hopperUrl;
  if (m.docker) return o.reachable;
  return `http://127.0.0.1:${o.port}`;
}
