// The user's Podman hosts from the command line (issue #2272, design.md "Podman hosts"): `hopper machine podman-host
// list` prints them (GET /api/podman-hosts); `add` adds one, `remove` removes one, each the whole list against the
// version read (POST /ui/api/podman-hosts), as the Settings section does. Add confirms the host key as the UI does: with
// no --host-key it only reads the key the host presents (POST /ui/api/machines/host-key) and its fingerprint, for the
// person to compare with the host's own, and adds nothing; run again with --host-key to pin that key.
import { OperatorRefusal, usage, type Call, type Getter } from './cli-operator-call.ts';
import type { HostKeyOffer } from './domain/machines.ts';
import type { PodmanHost, PodmanHostsView } from './domain/podman-hosts.ts';

export const PODMAN_HOST_USAGE = `  hopper machine podman-host list                    the Podman hosts sandboxes may start on, over ssh
  hopper machine podman-host add <name> <user@host> [--host-key KEY] [--cpus N] [--memory-mb N] [--label TEXT]
                                                     add one: with no --host-key, print the key it presents to compare first
  hopper machine podman-host remove <name>           remove one`;

const LINE = 'machine podman-host list | add <name> <user@host> [--host-key KEY] [--cpus N] [--memory-mb N] [--label TEXT] | remove <name>';
const hostsOf = (a: unknown): PodmanHost[] => (a as PodmanHostsView).hosts;
const read = async (get: Getter): Promise<PodmanHostsView> => (await get('/api/podman-hosts')) as PodmanHostsView;

/** The flags of `add`: each once, with a value. */
function flags(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i]!, rest[i + 1]];
    if (!['--host-key', '--cpus', '--memory-mb', '--label'].includes(flag) || value === undefined || flag in out) throw usage(LINE);
    out[flag] = value;
  }
  return out;
}

const number = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) throw usage(LINE);
  return n;
};

export function podmanHostCall(args: string[]): Call {
  const [verb, name, ...rest] = args;
  if (verb === 'list' && name === undefined) return { role: 'viewer', path: '/api/podman-hosts', pick: hostsOf };
  if (verb === 'remove' && name && rest.length === 0) {
    return {
      role: 'admin', path: '/ui/api/podman-hosts', pick: hostsOf,
      post: async (get) => {
        const view = await read(get);
        if (!view.hosts.some((h) => h.name === name)) throw new OperatorRefusal(`no Podman host is named ${name}`);
        return { path: '/ui/api/podman-hosts', body: { hosts: view.hosts.filter((h) => h.name !== name), version: view.version } };
      },
    };
  }
  if (verb === 'add' && name && rest[0] && !rest[0].startsWith('-')) {
    const ssh = rest[0];
    const f = flags(rest.slice(1));
    const hostKey = f['--host-key'];
    const [cpus, memoryMb] = [number(f['--cpus']), number(f['--memory-mb'])];
    if (hostKey === undefined) {
      return {
        role: 'admin', path: '/ui/api/machines/host-key', body: async () => ({ ssh }),
        pick: (a) => {
          const offer = a as HostKeyOffer;
          return { added: false, ...offer, next: `compare the fingerprint with the host's own (on the host: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then run: hopper machine podman-host add ${name} ${ssh} --host-key '${offer.hostKey}'` };
        },
      };
    }
    const host: PodmanHost = { name, ssh, hostKey, ...(f['--label'] ? { label: f['--label'] } : {}), ...(cpus !== undefined ? { cpus } : {}), ...(memoryMb !== undefined ? { memoryMb } : {}) };
    return {
      role: 'admin', path: '/ui/api/podman-hosts', pick: hostsOf,
      post: async (get) => {
        const view = await read(get);
        if (view.hosts.some((h) => h.name === name)) throw new OperatorRefusal(`a Podman host is named ${name} already: remove it first`);
        return { path: '/ui/api/podman-hosts', body: { hosts: [...view.hosts, host], version: view.version } };
      },
    };
  }
  throw usage(LINE);
}
