// Who is asking (design.md "Reaching the UI across the LAN", "Sign-in: realms"). A
// request is local (loopback peer, Host 127.0.0.1:<port> or localhost:<port>), LAN (Host a LAN name
// with the port) or public (Host the public URL's host, as a reverse proxy passes it on, or the remote access
// domain while remote access is on, as the tunnel passes it on: issue #880); a LAN or
// public request comes from loopback or a LAN peer range. A LAN peer naming a loopback Host is a LAN
// request: a port a container publishes on its host's loopback arrives that way (issue #119). The tailnet's names and addresses
// this host has, found at runtime, and the hosts the admin allowed in Settings are LAN names too, read at each request; while
// this host is on a tailnet, a peer in the tailnet's ranges is a LAN peer (issue #1024). Anything else is refused: another Host is
// 421 (DNS rebinding), another peer is 403. A LAN or public request reads /api/ only with a UI session.
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export interface Lan {
  /** Host names (lowercase, no port) this daemon answers to on the LAN. Empty: loopback only. */
  names: readonly string[];
  /** CIDR ranges a LAN or public request may come from. */
  peers: readonly string[];
  /** HOPPER_PUBLIC_URL's origin (`https://hopper.example.com`), or undefined. */
  publicUrl?: string | undefined;
  /** The remote access URL (`https://<domain>`, issue #880) while remote access is on, read at each request; undefined: off. */
  tunnelUrl?: () => string | undefined;
  /** More LAN names, read at each request (issue #1024): the tailnet's names and addresses this host has, and the hosts the admin allowed. */
  moreNames?: () => readonly string[];
  /** Whether this host is on a tailnet now (issue #1024): a peer in the tailnet's ranges is then a LAN peer. */
  tailnet?: () => boolean;
}

/** The ranges Tailscale gives a tailnet's devices their addresses from (issue #1024). */
export const TAILNET_RANGES = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'] as const;

export type Reach = { reach: 'local' | 'lan' | 'public' } | { refuse: 403 | 421; why: string };

export const loopbackHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];
/** A name's Host header value with the port: an IPv6 address in brackets. */
const withPort = (name: string, port: number): string => (isIPv6(name) ? `[${name}]:${port}` : `${name}:${port}`);
/** Every LAN name: the configured ones, then the ones read at each request (issue #1024), each once, lowercase. */
export const lanNames = (lan: Lan): string[] => [...new Set([...lan.names, ...(lan.moreNames?.() ?? [])].map((n) => n.toLowerCase()))];
export const lanHosts = (port: number, lan: Lan): string[] => lanNames(lan).map((n) => withPort(n, port));
/** The public URL's and the remote access URL's Host header values (each host, with the port only when it is not the scheme's default). */
export const publicHosts = (lan: Lan): string[] => [lan.publicUrl, lan.tunnelUrl?.()].filter((u) => u !== undefined).map((u) => new URL(u).host);
/** The origin a public request with Host `host` reached: the public URL's or the remote access URL's; undefined: neither. */
export const publicOriginOf = (lan: Lan, host: string): string | undefined =>
  [lan.publicUrl, lan.tunnelUrl?.()].find((u) => u !== undefined && new URL(u).host === host.toLowerCase());
/** Every Origin a UI page may post from. */
export const uiOrigins = (port: number, lan: Lan): string[] =>
  [...[...loopbackHosts(port), ...lanHosts(port, lan)].map((h) => `http://${h}`), ...(lan.publicUrl ? [lan.publicUrl] : [])];

/** `::ffff:a.b.c.d` → `a.b.c.d`; anything else unchanged. */
const unmapped = (peer: string): string => (peer.toLowerCase().startsWith('::ffff:') && isIPv4(peer.slice(7)) ? peer.slice(7) : peer);

const isLoopback = (peer: string): boolean => peer === '::1' || (isIPv4(peer) && peer.startsWith('127.'));

export function peerList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split('/');
    list.addSubnet(net!, Number(bits), isIPv6(net!) ? 'ipv6' : 'ipv4');
  }
  return list;
}

const tailnetPeers = peerList(TAILNET_RANGES);
const listedIn = (list: BlockList, peer: string): boolean => list.check(peer, isIPv6(peer) ? 'ipv6' : 'ipv4');

export function classifyRequest(req: { host: string | undefined; peer: string | undefined }, port: number, lan: Lan, peers = peerList(lan.peers)): Reach {
  const host = (req.host ?? '').toLowerCase();
  const peer = unmapped(req.peer ?? '');
  const local = isLoopback(peer);
  const lanKnown = lanHosts(port, lan);
  const known = [...loopbackHosts(port), ...lanKnown, ...publicHosts(lan)];
  if (!local) {
    const listed = peer !== '' && ((lan.peers.length > 0 && listedIn(peers, peer)) || (lan.tailnet?.() === true && listedIn(tailnetPeers, peer)));
    if (!listed) return { refuse: 403, why: `peer ${peer || '(unknown)'} is not on loopback, in HOPPER_LAN_PEERS or on this host's tailnet` };
    if (lanKnown.includes(host) || loopbackHosts(port).includes(host)) return { reach: 'lan' };
    if (publicHosts(lan).includes(host)) return { reach: 'public' };
    return { refuse: 421, why: `misdirected request: Host must be ${known.join(' or ')}` };
  }
  if (loopbackHosts(port).includes(host)) return { reach: 'local' };
  if (lanKnown.includes(host)) return { reach: 'lan' };
  if (publicHosts(lan).includes(host)) return { reach: 'public' };
  return { refuse: 421, why: `misdirected request: Host must be ${known.join(' or ')}` };
}
