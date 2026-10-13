// Where an artifact's links point (issue #673, design.md "Artifacts"): the base a link a job reports, or a notification,
// is built on. The first real artifact's link named the first LAN name, a container's bare name no LAN client resolved.
// `reachBase` is a job's way to the hopper from an ssh or container target (issue #695, src/github-proxy/reach.ts);
// `personBase` is the base of a person's link (issue #712): a container's bare name is never one, and the host link base,
// the address people open, defaults to loopback on the computer that runs the hopper. Pure.
import { isIPv4 } from 'node:net';

/** A LAN name a LAN client resolves without help: an IPv4 address, or a multicast DNS name. */
const resolvable = (name: string): boolean => isIPv4(name) || name.endsWith('.local');

/** Where the hopper is reached from off this machine: its link base, its public URL, its LAN names, and its port. */
export interface HopperReach { linkBase: string; publicUrl?: string | undefined; lanNames: readonly string[]; port: number }

/**
 * The hopper's URL as another machine reaches it (issues #673, #695): the user's link base (Settings → Artifacts) when
 * set; else the public URL's origin; else the first LAN name that is an IPv4 address or ends in `.local`, else the first
 * LAN name, with the port; else none.
 */
export function reachBase(o: HopperReach): string | undefined {
  if (o.linkBase) return o.linkBase;
  if (o.publicUrl) return new URL(o.publicUrl).origin;
  const name = o.lanNames.find(resolvable) ?? o.lanNames[0];
  return name ? `http://${name}:${o.port}` : undefined;
}

/** Where a person opens the hopper: `HopperReach`, and the instance's host link base (empty: not set, issue #712). */
export interface PersonReach extends HopperReach { hostLinkBase: string }

/** The default host link base (issue #712): loopback on the computer that runs the hopper, by name, so WSL forwards it. */
export const defaultHostLinkBase = (port: number): string => `http://localhost:${port}`;

/**
 * The base of a person's link — a UI link, a notification's question link, an artifact's link (issues #673, #712): the
 * user's link base when set; else the public URL's origin; else the host link base when set; else a LAN name that is an
 * IPv4 address or ends in `.local`, with the port; else `http://localhost:<port>`. Never a bare LAN name such as a
 * container's, which only its container network resolves.
 */
export function personBase(o: PersonReach): string {
  if (o.linkBase) return o.linkBase;
  if (o.publicUrl) return new URL(o.publicUrl).origin;
  if (o.hostLinkBase) return o.hostLinkBase;
  const name = o.lanNames.find(resolvable);
  return name ? `http://${name}:${o.port}` : defaultHostLinkBase(o.port);
}

/** The stable URL of an artifact under `base`: the UI's Artifacts view. */
export const artifactUrl = (base: string, id: string): string => `${base}/#artifacts/${id}`;
