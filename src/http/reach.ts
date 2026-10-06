// Who is asking (design.md "Reaching the UI across the LAN", "Sign-in: realms"). A
// request is local (loopback peer, Host 127.0.0.1:<port> or localhost:<port>), LAN (Host a LAN name
// with the port) or public (Host the public URL's host, as a reverse proxy passes it on); a LAN or
// public request comes from loopback or a LAN peer range. A LAN peer naming a loopback Host is a LAN
// request: a port a container publishes on its host's loopback arrives that way (issue #119). Anything else is refused: another Host is
// 421 (DNS rebinding), another peer is 403. A LAN or public request reads /api/ only with a UI session.
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export interface Lan {
  /** Host names (lowercase, no port) this daemon answers to on the LAN. Empty: loopback only. */
  names: readonly string[];
  /** CIDR ranges a LAN or public request may come from. */
  peers: readonly string[];
  /** HOPPER_PUBLIC_URL's origin (`https://hopper.example.com`), or undefined. */
  publicUrl?: string | undefined;
}

export type Reach = { reach: 'local' | 'lan' | 'public' } | { refuse: 403 | 421; why: string };

export const loopbackHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];
export const lanHosts = (port: number, lan: Lan): string[] => lan.names.map((n) => `${n}:${port}`);
/** The public URL's Host header value (its host, with the port only when it is not the scheme's default). */
export const publicHosts = (lan: Lan): string[] => (lan.publicUrl ? [new URL(lan.publicUrl).host] : []);
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

export function classifyRequest(req: { host: string | undefined; peer: string | undefined }, port: number, lan: Lan, peers = peerList(lan.peers)): Reach {
  const host = (req.host ?? '').toLowerCase();
  const peer = unmapped(req.peer ?? '');
  const local = isLoopback(peer);
  const known = [...loopbackHosts(port), ...lanHosts(port, lan), ...publicHosts(lan)];
  if (!local) {
    const listed = peer !== '' && lan.peers.length > 0 && peers.check(peer, isIPv6(peer) ? 'ipv6' : 'ipv4');
    if (!listed) return { refuse: 403, why: `peer ${peer || '(unknown)'} is not on loopback or in HOPPER_LAN_PEERS` };
    if (lanHosts(port, lan).includes(host) || loopbackHosts(port).includes(host)) return { reach: 'lan' };
    if (publicHosts(lan).includes(host)) return { reach: 'public' };
    return { refuse: 421, why: `misdirected request: Host must be ${known.join(' or ')}` };
  }
  if (loopbackHosts(port).includes(host)) return { reach: 'local' };
  if (lanHosts(port, lan).includes(host)) return { reach: 'lan' };
  if (publicHosts(lan).includes(host)) return { reach: 'public' };
  return { refuse: 421, why: `misdirected request: Host must be ${known.join(' or ')}` };
}
