// Issue #2146 (the bastion path, part 1): a bastion's box. The targets a job names, each reached by an observe of the
// template on its namespace or its cluster; the kubeconfig whose tokens are files; the forward script. Then one bastion
// box run at the container runtime double, its real script under `sh` with a fake `kubectl` on PATH: the forward to each
// target on 127.0.0.1 in the box, its token read from the file, a renewed token read once the hopper copies it in, and
// the box gone once it is stopped.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerSpec } from '../../src/domain/ports.ts';
import type { OperationProfile } from '../../src/domain/access.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { runNeedBox, type RunningNeedBox, type SecretsRenewal } from '../../src/sandbox/need-box.ts';
import {
  bastionCommand, bastionEnv, bastionKubeconfig, bastionTokens, parseTargets, placeTargets, BASTION_TARGETS_MAX, type BastionCredential,
} from '../../src/sandbox/bastion.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';

const observe = (kind: 'cluster' | 'namespace', name: string): OperationProfile => ({ operation: 'observe', asset: { kind, name } });
const MONITORING = observe('namespace', 'uat/monitoring');
const UAT = observe('cluster', 'uat');
const credential = (profile: OperationProfile, token: string): BastionCredential => ({
  profile, minted: { kind: 'kube', token, expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://uat.example:6443', certificateAuthorityData: 'Q0E=' },
});

describe('a bastion\'s targets (issue #2146)', () => {
  it('reads each target as <cluster>/<namespace>/<kind>/<name>:<port>, the same one once', () => {
    expect(parseTargets('uat/monitoring/svc/prometheus-server:9090  uat/monitoring/svc/grafana:80 uat/monitoring/svc/grafana:80')).toEqual([
      { cluster: 'uat', namespace: 'monitoring', kind: 'svc', name: 'prometheus-server', port: 9090 },
      { cluster: 'uat', namespace: 'monitoring', kind: 'svc', name: 'grafana', port: 80 },
    ]);
    expect(parseTargets('identity-eks/identity/pod/identity-server-postgresql-0:5432')).toEqual([{ cluster: 'identity-eks', namespace: 'identity', kind: 'pod', name: 'identity-server-postgresql-0', port: 5432 }]);
  });

  it('refuses what it cannot read, and says what to write', () => {
    expect(parseTargets(undefined)).toMatch(/^name the targets with --targets: a target is <cluster>\/<namespace>\/<svc\|pod\|deploy>\/<name>:<port>/);
    expect(parseTargets('uat/monitoring/svc/grafana')).toMatch(/^uat\/monitoring\/svc\/grafana: a target is/);
    expect(parseTargets('uat/monitoring/secret/grafana:80')).toMatch(/forward to svc, pod, deploy only, not secret/);
    expect(parseTargets('uat/monitoring/svc/grafana:70000')).toMatch(/the port is 1 to 65535/);
    expect(parseTargets('uat/Monitoring/svc/grafana:80')).toMatch(/Monitoring is no namespace name/);
    expect(parseTargets('uat/monitoring/svc/$(id):80')).toMatch(/is no Kubernetes name/);
    const many = Array.from({ length: BASTION_TARGETS_MAX + 1 }, (_, i) => `uat/monitoring/svc/s${i}:80`).join(' ');
    expect(parseTargets(many)).toBe(`a bastion forwards to at most ${BASTION_TARGETS_MAX} targets, not ${BASTION_TARGETS_MAX + 1}`);
  });

  it('places each target on the observe of its namespace, else of its cluster, on a port of its own', () => {
    const targets = parseTargets('uat/monitoring/svc/prometheus-server:9090 uat/logging/svc/loki:3100') as Exclude<ReturnType<typeof parseTargets>, string>;
    const r = placeTargets(targets, [{ operation: 'read', asset: { kind: 'cluster', name: 'uat' } }, MONITORING, UAT]);
    expect(r).toEqual({
      placed: [
        { ...targets[0], context: 'uat-monitoring' },
        { ...targets[1], context: 'uat' },
      ],
      observes: [MONITORING, UAT],
    });
  });

  it('refuses a target no observe reaches: a read is not enough, and it says what to ask for', () => {
    const targets = parseTargets('uat/monitoring/svc/grafana:80 prod/monitoring/svc/grafana:80') as Exclude<ReturnType<typeof parseTargets>, string>;
    expect(placeTargets(targets, [MONITORING, { operation: 'read', asset: { kind: 'cluster', name: 'prod' } }])).toBe(
      'the template has no observe on prod/monitoring: ask for a template with observe/namespace/prod/monitoring',
    );
  });
});

describe('a bastion\'s box (issue #2146)', () => {
  it('its kubeconfig reads each context\'s token from a file beside it, never inline', () => {
    const config = JSON.parse(bastionKubeconfig([credential(MONITORING, 'first-token'), credential(UAT, 'cluster-token')]));
    expect(config).toMatchObject({
      'current-context': 'uat-monitoring',
      users: [{ name: 'uat-monitoring', user: { tokenFile: '../.hopper-need/secrets/kube-uat-monitoring' } }, { name: 'uat', user: { tokenFile: '../.hopper-need/secrets/kube-uat' } }],
      clusters: [{ name: 'uat-monitoring', cluster: { server: 'https://uat.example:6443', 'certificate-authority-data': 'Q0E=' } }, { name: 'uat' }],
      contexts: [{ name: 'uat-monitoring', context: { cluster: 'uat-monitoring', user: 'uat-monitoring' } }, { name: 'uat' }],
    });
    expect(JSON.stringify(config)).not.toContain('token"');
    expect(bastionTokens([credential(MONITORING, 'first-token'), credential(UAT, 'cluster-token')])).toEqual({ 'kube-uat-monitoring': 'first-token', 'kube-uat': 'cluster-token' });
  });

  it('its command forwards each target on 127.0.0.1 with its context and namespace, again when a forward ends', () => {
    const command = bastionCommand([{ cluster: 'uat', namespace: 'monitoring', kind: 'svc', name: 'grafana', port: 80, context: 'uat-monitoring' }]);
    expect(command).toContain('kubectl --context "$1" --namespace "$2" port-forward --address 127.0.0.1 "$3" ":$4"');
    expect(command).toContain('forward \'uat-monitoring\' \'monitoring\' \'svc/grafana\' 80 \'uat/monitoring/svc/grafana:80\' &');
    expect(command).toMatch(/sleep 2\n {2}done/);
  });

  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null) try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

  /** The runtime double: its box's script runs under `sh` with a home of its own and a fake kubectl first on PATH; a stop kills it. */
  function runtime(): { r: FakeContainerRuntime; home: string } {
    const r = createFakeContainerRuntime();
    const home = temp('bastion-home-'), bin = temp('bastion-bin-');
    // The fake kubectl writes its arguments and the token its context's tokenFile holds, each time the token changes.
    writeFileSync(join(bin, 'kubectl'), `#!/bin/sh
tf=$(sed -n 's/.*"tokenFile":"\\([^"]*\\)".*/\\1/p' "$KUBECONFIG")
seen=
while :; do
  now=$(cat "$(dirname "$KUBECONFIG")/$tf")
  if [ "$now" != "$seen" ]; then echo "kubectl $* token=$now" >> "$HOME/kubectl.log"; echo "Forwarding from 127.0.0.1:20000 -> 80"; seen=$now; fi
  sleep 0.05
done
`);
    chmodSync(join(bin, 'kubectl'), 0o755);
    let running: ChildProcess | undefined;
    r.copyIn = async (id, dir, tar) => {
      const c = [...r.boxes.values()].find((b) => b.id === id);
      if (!c || c.state !== 'running') throw new Error(`the box ${id} is not running`);
      r.copies.push({ box: c.spec.name, dir });
      mkdirSync(dir.replace(HOME, home), { recursive: true });
      execFileSync('tar', ['-xf', tar, '-C', dir.replace(HOME, home)]);
    };
    r.runScript = (spec: ContainerSpec) => new Promise((resolve) => {
      const child = spawn('sh', ['-c', spec.script ?? ''], { env: { ...spec.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, detached: true });
      running = child;
      children.push(child);
      let output = '';
      child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
      child.on('exit', (code) => resolve({ exit: code ?? 143, output }));
    });
    const stop = r.stop.bind(r);
    r.stop = async (id) => { if (running?.exitCode === null) process.kill(-running.pid!, 'SIGTERM'); await stop(id); };
    return { r, home };
  }

  const until = async (what: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !what(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(what()).toBe(true);
  };

  it('forwards with the token in its file, reads a renewed token once it is copied in, and goes when it is stopped', async () => {
    const { r, home } = runtime();
    const placed = [{ cluster: 'uat', namespace: 'monitoring', kind: 'svc' as const, name: 'grafana', port: 80, context: 'uat-monitoring' }];
    const creds = [credential(MONITORING, 'first-token')];
    const stop = new AbortController();
    let renew: SecretsRenewal | undefined;
    let pipe: RunningNeedBox['pipe'];
    const piped: [string, readonly string[]][] = [];
    r.pipe = async (id, cmd) => { piped.push([id, cmd]); return Object.assign(new PassThrough(), { stderr: () => '' }); };
    const lines: string[] = [];
    const ran = runNeedBox(r, {
      name: 'hopper-bastion-1', userId: 'u1', instanceId: 'i1', network: 'hopper_default', template: { image: 'ghcr.io/henningfutrell/hopper:box' },
      env: bastionEnv(placed, creds), timeoutMs: 30_000, dir: temp('bastion-dir-'), files: { secrets: bastionTokens(creds) },
    }, { log: (l) => lines.push(l), signal: stop.signal, pollMs: 10, running: (box) => { renew = box.renew; pipe = box.pipe; } });
    const log = join(home, 'kubectl.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('token=first-token'));
    expect(readFileSync(log, 'utf8')).toContain('kubectl --context uat-monitoring --namespace monitoring port-forward --address 127.0.0.1 svc/grafana :80 token=first-token');
    // The kubeconfig in the box holds no token: only where its file is.
    expect(readFileSync(join(home, '.kube', 'config'), 'utf8')).not.toContain('first-token');
    expect(renew).toBeDefined();
    // The relay's way in (part 2): a command started in this box, by its id.
    await pipe!(['true']);
    expect(piped).toEqual([[r.boxes.get('hopper-bastion-1')!.id, ['true']]]);
    await renew!(bastionTokens([credential(MONITORING, 'second-token')]));
    await until(() => readFileSync(log, 'utf8').includes('token=second-token'));
    expect(r.boxes.get('hopper-bastion-1')?.spec.env).not.toHaveProperty('KUBECONFIG');
    expect(JSON.stringify(r.boxes.get('hopper-bastion-1')?.spec.env)).not.toContain('first-token');
    stop.abort();
    expect(await ran).toEqual({ exit: 125, problem: 'the job stopped waiting for it', stopped: 'cancelled' });
    expect(r.boxes.size).toBe(0);
    expect(r.volumes.size).toBe(0);
  });
});
