// The egress of the cloud acceptance tests (issue #1956, criterion 7): what compose gives a read-only box beside the
// hopper (design.md "A read-only box's egress"), made with the real container runtime. An internal network with no
// route out; the egress proxy, the compose service `egress` itself (its script read from compose.yaml, the hopper's image,
// tinyproxy) on that network and on a routed one; and moto on the routed network only, the one host the test allows. The
// hopper's side is the real `createEgress`, writing the allowlist into a directory the proxy mounts.
// HOPPER_TEST_EGRESS_IMAGE names another image for the proxy: it must carry tinyproxy.
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import { containerLabels } from '../../support/sweep.ts';
import { cli } from './box.ts';
import { MOTO_IMAGE } from './moto.ts';

/** The hopper's image of the dev channel: the first that carries tinyproxy (issue #849). */
export const EGRESS_IMAGE = process.env.HOPPER_TEST_EGRESS_IMAGE ?? 'ghcr.io/henningfutrell/hopper:dev';
const ROOT = join(import.meta.dirname, '..', '..', '..');
/** Where the compose service mounts the allowlist the hopper writes. */
const SHARED = '/run/hopper-egress';
const PROXY_PORT = 3128;
const MOTO_PORT = 5000;

export interface EgressStack {
  /** The internal network a read-only box joins. */
  network: string;
  /** The proxy's URL, as a box on the internal network names it. */
  proxy: string;
  /** The directory the hopper writes the allowlist into. */
  dir: string;
  /** moto's name and address on the routed network: the host the test allows, and the same host by its IP. */
  allowed: { host: string; port: number; ip: string };
  /** The proxy's log: tinyproxy's connections and refusals. */
  log(): Promise<string>;
  end(): Promise<void>;
}

/** The compose service `egress`'s script, as the shell runs it (compose's `$$` is a `$`). */
export function egressScript(): string {
  const compose = parse(readFileSync(join(ROOT, 'compose.yaml'), 'utf8')) as { services: { egress: { command: string[] } } };
  return compose.services.egress.command.join('\n').replaceAll('$$', '$');
}

/**
 * `hostAlias`: a name the proxy resolves to this machine (the runtime's `host-gateway`), so it reaches a service the test
 * runs here, such as the policy-assert proxy listening on every interface.
 */
export async function startEgressStack(o: { hostAlias?: string } = {}): Promise<EgressStack> {
  const id = randomBytes(4).toString('hex');
  const internal = `hopper-acceptance-egress-${id}`, routed = `hopper-acceptance-out-${id}`;
  const proxyName = `hopper-acceptance-proxy-${id}`, motoName = `hopper-acceptance-moto-${id}`;
  const labels = Object.entries(containerLabels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const dir = mkdtempSync(join(tmpdir(), 'hopper-acceptance-egress-'));
  // The proxy runs as the image's user and writes `loaded` here.
  chmodSync(dir, 0o777);
  const containers: string[] = [], networks: string[] = [];
  const must = async (argv: string[]): Promise<string> => {
    const r = await cli(argv);
    if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const end = async (): Promise<void> => {
    for (const c of containers.splice(0)) await cli(['rm', '-f', '-t', '0', c]);
    for (const n of networks.splice(0)) await cli(['network', 'rm', n]);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await must(['network', 'create', '--internal', internal]);
    networks.push(internal);
    await must(['network', 'create', routed]);
    networks.push(routed);
    await must(['run', '-d', '--name', motoName, '--network', routed, ...labels, MOTO_IMAGE]);
    containers.push(motoName);
    await must(['create', '--name', proxyName, '--network', routed, ...labels,
      ...(o.hostAlias ? ['--add-host', `${o.hostAlias}:host-gateway`] : []), '-v', `${dir}:${SHARED}`, '--entrypoint', 'sh', EGRESS_IMAGE, '-eu', '-c', egressScript()]);
    containers.push(proxyName);
    await must(['network', 'connect', internal, proxyName]);
    await must(['start', proxyName]);
    const ip = await must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${routed}").IPAddress}}`, motoName]);
    return {
      network: internal, proxy: `http://${proxyName}:${PROXY_PORT}`, dir,
      allowed: { host: motoName, port: MOTO_PORT, ip },
      log: async () => { const r = await cli(['logs', proxyName]); return r.stdout + r.stderr; },
      end,
    };
  } catch (e) {
    await end();
    throw e;
  }
}
