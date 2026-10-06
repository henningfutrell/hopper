// Is this ssh target this machine? (issue #275) What `ssh -G` makes of it — the user's own ssh config —
// is compared with this host: it is this machine when ssh would reach this host as the user the hopper
// runs as, on ssh's own port. This host is its loopback, its own host name, and the addresses of its
// interfaces; a HostName that is none of them is resolved and each address compared. Another user is
// another account, another port another machine (a container's published sshd); a target that cannot
// be resolved is not this machine. Nothing is reached over the network.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { resolveDestination } from '../executors/ssh.ts';

/** How long a name may take to resolve before the target counts as another machine. */
const LOOKUP_MS = 2000;

export interface ThisMachineDeps {
  /** What ssh makes of the target: HostName, User, Port. Throws when it cannot (a ProxyJump, no ssh). */
  destination?: (target: string) => { hostname: string; user: string; port: string };
  /** The user the hopper runs as. */
  user?: string;
  /** This host's own names. */
  names?: () => string[];
  /** The addresses of this host's interfaces. */
  addresses?: () => string[];
  /** Every address a name resolves to. */
  lookup?: (host: string) => Promise<string[]>;
}

const isLoopback = (a: string): boolean => a === '::1' || a.startsWith('127.') || a === '::ffff:127.0.0.1';
const plain = (a: string): string => a.replace(/^::ffff:(?=\d+\.)/, '').replace(/%.*$/, '').toLowerCase();

function ownNames(): string[] {
  const name = hostname().toLowerCase();
  return [name, name.split('.')[0]!];
}

function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
}

async function resolveAll(host: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`resolving ${host} took too long`)), LOOKUP_MS); });
  try {
    return (await Promise.race([dnsLookup(host, { all: true }), late])).map((r) => r.address);
  } finally {
    clearTimeout(timer);
  }
}

export async function isThisMachine(target: string, d: ThisMachineDeps = {}): Promise<boolean> {
  let dest: { hostname: string; user: string; port: string };
  try {
    dest = (d.destination ?? ((t) => resolveDestination('ssh', t)))(target);
  } catch {
    return false;
  }
  if (dest.port !== '22' || dest.user !== (d.user ?? userInfo().username)) return false;
  const host = plain(dest.hostname);
  if (host === 'localhost' || (d.names ?? ownNames)().map((n) => n.toLowerCase()).includes(host)) return true;
  const own = new Set((d.addresses ?? ownAddresses)().map(plain));
  const here = (a: string): boolean => isLoopback(plain(a)) || own.has(plain(a));
  if (isIP(host)) return here(host);
  try {
    return (await (d.lookup ?? resolveAll)(host)).some(here);
  } catch {
    return false;
  }
}
