// This host's tailnet (issue #1024, design.md "Reaching the UI across a tailnet"): the MagicDNS name and the addresses
// Tailscale gave this host, found at runtime, so a request from another device on the tailnet that names them is a LAN
// request, not a 421. Asked of tailscaled's local API on its socket — what `tailscale status --json` reads —, else read
// from the addresses of the host's own Tailscale interface. Nothing of one tailnet is in the code or a default. Read at the
// start and again every minute, as Tailscale may come up after the hopper or change its addresses.
// No library: no maintained Node client of tailscaled's local API exists, and the one read is a GET on a Unix socket.
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { isIPv6 } from 'node:net';
import { peerList, TAILNET_RANGES } from './reach.ts';

/** What this host is on its tailnet: its names (the MagicDNS name and its first label) and its addresses. */
export interface TailnetSelf { names: string[]; addresses: string[] }

/** Reads this host's tailnet now; undefined: not on one, or nothing could be read. */
export type TailnetSource = () => Promise<TailnetSelf | undefined>;

/** Where tailscaled's local API listens on Linux; a container reaches it when the host's socket is mounted there. */
export const TAILSCALED_SOCKETS = ['/var/run/tailscale/tailscaled.sock', '/run/tailscale/tailscaled.sock'] as const;

const REFRESH_MS = 60_000;
const TIMEOUT_MS = 2000;

interface Status { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } }

/** The names and addresses of a `tailscale status --json` answer; undefined when this host is not up on a tailnet. */
export function selfOf(status: unknown): TailnetSelf | undefined {
  const s = status as Status | null;
  if (s?.BackendState !== 'Running' || !s.Self) return undefined;
  const dns = (s.Self.DNSName ?? '').toLowerCase().replace(/\.$/, '');
  const names = dns === '' ? [] : [dns, dns.split('.')[0]!].filter((n, i, all) => all.indexOf(n) === i);
  const addresses = (s.Self.TailscaleIPs ?? []).map((a) => a.toLowerCase());
  return names.length + addresses.length === 0 ? undefined : { names, addresses };
}

/** GET /localapi/v0/status on tailscaled's socket; undefined when it does not answer. */
function localApiStatus(socketPath: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/localapi/v0/status', headers: { host: 'local-tailscaled.sock' }, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(undefined);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(undefined); }
      });
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

const tailnetRanges = peerList(TAILNET_RANGES);

/** The addresses in the tailnet's ranges on this host's Tailscale interfaces (`tailscale0` on Linux). */
export function interfaceAddresses(interfaces = networkInterfaces()): string[] {
  return Object.entries(interfaces).filter(([name]) => name.startsWith('tailscale'))
    .flatMap(([, list]) => (list ?? []).map((i) => i.address.toLowerCase()))
    .filter((a) => tailnetRanges.check(a, isIPv6(a) ? 'ipv6' : 'ipv4'));
}

/** The real source: tailscaled's local API, else the Tailscale interface's addresses. */
export function tailscaleSource(sockets: readonly string[] = TAILSCALED_SOCKETS): TailnetSource {
  return async () => {
    for (const socket of sockets) {
      const self = selfOf(await localApiStatus(socket));
      if (self) return self;
    }
    const addresses = interfaceAddresses();
    return addresses.length === 0 ? undefined : { names: [], addresses };
  };
}

export interface Tailnet {
  /** This host's tailnet names and addresses as last read; empty: not on a tailnet. */
  names(): string[];
  /** Whether this host was on a tailnet at the last read. */
  on(): boolean;
  /** Reads it again now. */
  refresh(): Promise<void>;
  stop(): void;
}

/** Reads the source now and every minute; a change is one log line. */
export function watchTailnet(o: { source: TailnetSource; logger: { info(line: string): void }; refreshMs?: number }): Tailnet {
  let self: TailnetSelf | undefined;
  const refresh = async (): Promise<void> => {
    const next = await o.source().catch(() => undefined);
    const was = JSON.stringify(self ?? null), now = JSON.stringify(next ?? null);
    self = next;
    if (was !== now) o.logger.info(next ? `hopper: on a tailnet: the UI also answers to ${[...next.names, ...next.addresses].join(', ')}` : 'hopper: not on a tailnet');
  };
  void refresh();
  const timer = setInterval(() => void refresh(), o.refreshMs ?? REFRESH_MS);
  timer.unref();
  return {
    names: () => (self ? [...self.names, ...self.addresses] : []),
    on: () => self !== undefined,
    refresh,
    stop: () => clearInterval(timer),
  };
}
