// Allowed hosts (issue #1024, design.md "Reaching the UI across a tailnet"): the host names and addresses the UI answers to
// beyond the LAN names — the ones the hopper found on this host's tailnet, and the ones the hopper's admin allowed in Settings
// or through the API, never in a file. Each is a LAN name: a request naming it, with the hopper's port, still needs a UI
// session or a token. Pure.

/** At most this many allowed hosts. */
export const ALLOWED_HOSTS_MAX = 50;

/** A host name (labels of letters, digits and hyphens) or an IPv4 or IPv6 address; no port, no scheme. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/;

/** Why `host` is no allowed host; undefined: it is one. Loopback is always allowed, so it is no entry. */
export function allowedHostProblem(host: string): string | undefined {
  if (host.length > 253) return `${host.slice(0, 40)}…: longer than 253 characters`;
  if (host.includes(':') && !IPV6.test(host)) return `${host}: a host name or address with no port and no scheme`;
  if (!host.includes(':') && !NAME.test(host)) return `${host}: a host name or address with no port and no scheme`;
  if (/^\d+(\.\d+)*$/.test(host) && !IPV4.test(host)) return `${host}: not an IPv4 address`;
  if (host === 'localhost' || host.startsWith('127.') || host === '::1') return `${host}: loopback is always allowed`;
  return undefined;
}

/** The list as kept: trimmed, lowercase, each once, in the order given. */
export const normalHosts = (hosts: readonly string[]): string[] => [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== ''))];

/** As GET /api/allowed-hosts answers it. */
export interface AllowedHostsView {
  /** The hosts the admin allowed. */
  hosts: string[];
  /** The LAN names HOPPER_LAN_NAMES sets, at launch. */
  lan: string[];
  /** This host's tailnet as the hopper last found it: on one or not, and its names and addresses there. */
  tailnet: { on: boolean; names: string[] };
  /** The port each is answered on. */
  port: number;
}
