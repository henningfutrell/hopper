// Where an artifact's links point (issue #673, design.md "Artifacts"): the base a link a job reports, or a notification,
// is built on. The first real artifact's link named the first LAN name, a container's bare name no LAN client resolved.
// Pure.
import { isIPv4 } from 'node:net';

/** A LAN name a LAN client resolves without help: an IPv4 address, or a multicast DNS name. */
const resolvable = (name: string): boolean => isIPv4(name) || name.endsWith('.local');

/**
 * The user's link base (Settings → Artifacts) when set; else the public URL's origin; else the first LAN name that is an
 * IPv4 address or ends in `.local`, else the first LAN name, with the port; else loopback.
 */
export function artifactBase(o: { linkBase: string; publicUrl?: string | undefined; lanNames: readonly string[]; port: number }): string {
  if (o.linkBase) return o.linkBase;
  if (o.publicUrl) return new URL(o.publicUrl).origin;
  const name = o.lanNames.find(resolvable) ?? o.lanNames[0];
  return name ? `http://${name}:${o.port}` : `http://127.0.0.1:${o.port}`;
}

/** The stable URL of an artifact under `base`: the UI's Artifacts view. */
export const artifactUrl = (base: string, id: string): string => `${base}/#artifacts/${id}`;
