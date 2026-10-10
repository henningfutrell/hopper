// Where a job on a machine reaches the hopper (issue #698, design.md "GitHub through the hopper"): its HOPPER_URL, for
// hopper-gh, git through the hopper, skills and artifacts. An ssh target was given the first LAN name, which only the
// hopper's compose network resolved: the job could not reach the hopper and fell back to a device sign-in. So an ssh
// target's probe asks the machine itself which of the hopper's addresses it reaches (`addressCommand`, at the address path),
// and a job there is given that one; when it reaches none, the machine has an **address problem** and takes no new job.
import type { MachineSnapshot } from '../domain/types.ts';
import { shellQuote } from '../executors/ssh.ts';

/** The route a machine's probe asks at each address: 204 and nothing else, from the hopper, behind the Host guard. */
export const ADDRESS_PATH = '/job/address';

/** What the address check prints, one line per address it asked, or that the machine has no curl. */
const LINE = 'hopper-address';
const NO_CURL = `${LINE} no-curl`;

/** Whether a line of a probe's output is the address check's. */
export const isAddressLine = (line: string): boolean => line.startsWith(`${LINE} `);

const SET_ADDRESS = 'set HOPPER_PUBLIC_URL to an address it reaches, or add a name it resolves to HOPPER_LAN_NAMES';

/** The hopper's addresses a machine may reach it at, in order: the public URL, then each LAN name with the port. */
export function hopperAddresses(o: { publicUrl?: string | undefined; lanNames: readonly string[]; port: number }): string[] {
  return [...(o.publicUrl ? [o.publicUrl.replace(/\/+$/, '')] : []), ...o.lanNames.map((n) => `http://${n}:${o.port}`)];
}

/**
 * The shell that asks the address path at each address, in order, until one answers 204: one line per address asked,
 * `hopper-address <status> <url>` (000: no connection). Each at most 3 s. Nothing to ask: nothing runs.
 */
export function addressCommand(urls: readonly string[]): string {
  if (urls.length === 0) return ':';
  return `if command -v curl >/dev/null 2>&1; then for u in ${urls.map(shellQuote).join(' ')}; do`
    + ` c=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "$u${ADDRESS_PATH}"); printf '${LINE} %s %s\\n' "\${c:-000}" "$u";`
    + ` if [ "$c" = 204 ]; then break; fi; done; else echo '${NO_CURL}'; fi`;
}

const why = (status: string): string => {
  if (status === '000') return 'no connection';
  if (status === '403') return 'refused: its address is not in HOPPER_LAN_PEERS';
  if (status === '421') return 'refused: the hopper does not answer to that name';
  return `answered ${status}, not as the hopper`;
};

/** What the address check found: the first address that answered as the hopper, or why none did. */
export function readAddress(stdout: string, urls: readonly string[]): { hopperUrl: string } | { addressProblem: string } {
  if (urls.length === 0) return { addressProblem: 'the hopper has no address a machine can reach it at: set HOPPER_PUBLIC_URL, or HOPPER_LAN_NAMES with names machines resolve' };
  const lines = stdout.split('\n').filter(isAddressLine);
  if (lines.includes(NO_CURL)) return { addressProblem: 'curl is not installed there: its jobs cannot reach the hopper' };
  const asked = new Map<string, string>();
  for (const l of lines) {
    const [, status, ...rest] = l.split(' ');
    asked.set(rest.join(' '), status ?? '');
  }
  const reached = urls.find((u) => asked.get(u) === '204');
  if (reached) return { hopperUrl: reached };
  const said = urls.map((u) => `${u} (${asked.has(u) ? why(asked.get(u)!) : 'not asked'})`).join('; ');
  return { addressProblem: `the hopper cannot be reached from it: ${said}. Its jobs need the hopper: ${SET_ADDRESS}` };
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
