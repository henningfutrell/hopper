// The egress of a read-only box (issue #849, design.md "A read-only box's egress"): a need box of a read-only template,
// and the read-only check box, beside the hopper. They join an internal network (`podman network create --internal`),
// which has no route out, and reach out only through the egress proxy: tinyproxy, the compose service `egress`, on that
// network and on the hopper's. The proxy lets a box CONNECT only to the allowlist: AWS's endpoints (`*.amazonaws.com`),
// the API server of each cluster the vault minted for a read-only box, and an STS endpoint a minting credential names.
// The box reaches the hopper past the proxy (NO_PROXY): the hopper is on the internal network too.
//
// The hopper writes the allowlist into a directory it shares with the proxy: `filter` (one ERE per host, tinyproxy's
// filter), `ports` (the ports a CONNECT may name) and, last, `version` (a hash of both). The proxy reloads when `version`
// changes, then writes the version it took into `loaded`. A box starts only once `loaded` says the proxy holds its hosts:
// a proxy that does not answer in time fails the box, so a read-only box never starts with egress the hopper did not set.
// The allowlist only grows while the hopper runs: a box's hosts stay allowed for the boxes after it. An approval of a
// template's new egress host adds its hosts too, before the approval is kept (issue #2639 part 4, src/vault/live-egress.ts).
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MintReach } from '../domain/minting.ts';

/** The domain each AWS endpoint is under: the read session's STS, S3, SSM and the other APIs it reads. */
export const AWS_DOMAIN = 'amazonaws.com';
/** The port of an HTTPS URL that names none. */
const HTTPS_PORT = 443;
/** How long a box waits for the proxy to take its allowlist. */
export const LOAD_WAIT_MS = 30_000;
const POLL_MS = 100;

/** Where the box's proxy is, and where the hopper shares the allowlist with it (HOPPER_SANDBOX_EGRESS_*). */
export interface EgressSettings { network: string; proxy: string; dir: string }

/** One host a box may CONNECT to, and its port. */
export interface EgressHost { host: string; port: number }

/** The host and port of an HTTPS URL; undefined for one it cannot read. */
function hostOf(url: string): EgressHost | undefined {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : HTTPS_PORT;
    return { host: u.hostname.toLowerCase(), port };
  } catch {
    return undefined;
  }
}

/** A template's egress host (issue #1875), `host:port` as the vault checked it when it was saved. */
function namedHost(h: string): EgressHost {
  const at = h.lastIndexOf(':');
  return { host: h.slice(0, at).toLowerCase(), port: Number(h.slice(at + 1)) };
}

/** Whether `host` is AWS's: `amazonaws.com` or a name under it. */
const underAws = (host: string): boolean => host === AWS_DOMAIN || host.endsWith(`.${AWS_DOMAIN}`);

/**
 * The hosts a box minted these credentials reaches beyond AWS's own endpoints: each cluster's API server, and an STS
 * endpoint that is not AWS's.
 */
export function egressHosts(reaches: readonly MintReach[]): EgressHost[] {
  return reaches.flatMap((r) => {
    const h = hostOf(r.kind === 'kube' ? r.server : r.stsEndpoint ?? '');
    return h && !(underAws(h.host) && h.port === HTTPS_PORT) ? [h] : [];
  });
}

/** A host as an anchored ERE: tinyproxy matches the host of each CONNECT against it. */
const exactly = (host: string): string => `^${host.replace(/[.[\]\\^$|?*+(){}]/g, '\\$&')}$`;

/** The allowlist's files: tinyproxy's filter, the ports a CONNECT may name, and their version. */
export function allowlist(hosts: readonly EgressHost[]): { filter: string; ports: string; version: string } {
  const names = [...new Set(hosts.map((h) => h.host))].filter((h) => !underAws(h)).sort();
  const filter = [`^([a-z0-9-]+\\.)*${AWS_DOMAIN.replace('.', '\\.')}$`, ...names.map(exactly)].join('\n') + '\n';
  const ports = [...new Set([HTTPS_PORT, ...hosts.map((h) => h.port)])].sort((a, b) => a - b).join('\n') + '\n';
  const version = createHash('sha256').update(filter).update('\0').update(ports).digest('hex').slice(0, 32);
  return { filter, ports, version };
}

export interface Egress {
  /** The internal network a read-only box joins. */
  readonly network: string;
  /** The variables that send a box's tools through the proxy, and to the hopper past it. */
  readonly env: Record<string, string>;
  /**
   * Adds the hosts of these credentials, and a template's egress hosts (`host:port`, issue #1875), to the allowlist;
   * resolves once the proxy holds them. Rejects when it does not in time.
   */
  allow(reaches: readonly MintReach[], named?: readonly string[]): Promise<void>;
}

/** The variables a box's tools read: aws, kubectl, helm and terraform obey HTTPS_PROXY and NO_PROXY. */
export function proxyEnv(proxy: string): Record<string, string> {
  const past = 'hopper,localhost,127.0.0.1';
  return { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: past, no_proxy: past };
}

/** Writes `name` whole: the proxy never reads it half written. */
async function put(dir: string, name: string, text: string): Promise<void> {
  const tmp = join(dir, `.${name}.tmp`);
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, join(dir, name));
}

export function createEgress(s: EgressSettings, o: { waitMs?: number; pollMs?: number } = {}): Egress {
  const hosts = new Map<string, EgressHost>();
  let written: string | undefined;
  // One write at a time: the allowlist is one file set.
  let queue: Promise<void> = Promise.resolve();
  const loaded = async (version: string): Promise<boolean> => (await readFile(join(s.dir, 'loaded'), 'utf8').catch(() => '')).trim() === version;
  const take = async (): Promise<void> => {
    const list = allowlist([...hosts.values()]);
    if (written !== list.version) {
      await put(s.dir, 'filter', list.filter);
      await put(s.dir, 'ports', list.ports);
      await put(s.dir, 'version', `${list.version}\n`);
      written = list.version;
    }
    const until = Date.now() + (o.waitMs ?? LOAD_WAIT_MS);
    while (!(await loaded(list.version))) {
      if (Date.now() >= until) throw new Error(`the egress proxy did not take the allowlist in ${Math.round((o.waitMs ?? LOAD_WAIT_MS) / 1000)} s (timed out): a read-only box starts only behind it. Is the compose service egress running? (docs/deploy.md "A read-only box's egress")`);
      await new Promise((r) => setTimeout(r, o.pollMs ?? POLL_MS));
    }
  };
  return {
    network: s.network,
    env: proxyEnv(s.proxy),
    allow(reaches, named = []) {
      for (const h of [...egressHosts(reaches), ...named.map(namedHost)]) hosts.set(`${h.host}:${h.port}`, h);
      const run = queue.then(take);
      queue = run.catch(() => {});
      return run;
    },
  };
}
