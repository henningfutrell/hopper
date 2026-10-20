// Issue #2146 (the bastion path, part 1), through the real composition root, the real HTTP server and the real
// `hopper-skill`: a job asks for a template with an observe on a namespace, then for a bastion of it to a service there.
// The vault mints the observe's token from the cluster's minting credential (a Kubernetes API faked on loopback); the
// container runtime is a double at its port whose box runs the bastion's real script under `sh`, with a fake kubectl
// that writes what it forwards and the token its file holds; OpenFGA is a double at its seam.
//
// Feature: bastions
//   Scenario: under YOLO, a job's template with an observe and its bastion start with no person; the bastion's box holds
//     the forward and its token as a file, never in its environment, the job's answer, or an event; the job stops it,
//     its box goes, its token's Secret is deleted, and its start and end are on the job's timeline
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { MINTED_KUBE_TOKEN } from '../support/fake-mint-apis.ts';
import { boot, runningJob, skill, stopAll, type Booted } from '../support/read-only-check.ts';
import { waitFor } from '../support/wait.ts';

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ }
  await stopAll();
});

const FAKE_KUBECTL = `#!/bin/sh
tf=$(sed -n 's/.*"tokenFile":"\\([^"]*\\)".*/\\1/p' "$KUBECONFIG")
echo "kubectl $* token=$(cat "$(dirname "$KUBECONFIG")/$tf")" >> "$HOME/kubectl.log"
echo "Forwarding from 127.0.0.1:20000 -> 3000"
exec sleep 600
`;

/** Booted, the box's script run under `sh` with a home of its own and the fake kubectl first on PATH; a stop kills it. */
function bastionBoxes(b: Booted): (name: string) => string {
  const homeOf = (name: string): string => { const h = join(b.cloud.dir, `home-${name}`); mkdirSync(h, { recursive: true }); return h; };
  const bin = join(b.cloud.dir, 'bastion-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
  chmodSync(join(bin, 'kubectl'), 0o755);
  const running = new Map<string, ChildProcess>();
  b.runtime.runScript = (spec) => new Promise((resolve) => {
    const child = spawn('sh', ['-c', spec.script ?? ''], { env: { ...spec.env, HOME: homeOf(spec.name), PATH: `${bin}:${process.env.PATH}` }, detached: true });
    running.set(spec.name, child);
    children.push(child);
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('exit', (code) => resolve({ exit: code ?? 143, output }));
  });
  b.runtime.copyIn = async (id, dir, tar) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id)!;
    const to = dir.replace(HOME, homeOf(c.spec.name));
    mkdirSync(to, { recursive: true });
    execFileSync('tar', ['-xf', tar, '-C', to]);
  };
  const stop = b.runtime.stop.bind(b.runtime);
  b.runtime.stop = async (id) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id);
    const child = c && running.get(c.spec.name);
    if (child?.exitCode === null) process.kill(-child.pid!, 'SIGTERM');
    await stop(id);
  };
  return homeOf;
}

describe('bastions (issue #2146)', () => {
  it('under YOLO a job starts a bastion of its observe template; the token stays in the box; the job stops it', async () => {
    const b = await boot([]);
    const homeOf = bastionBoxes(b);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;

    const made = await skill(b.a, creds, ['sandbox-template', '--why', 'Read the lab dashboards', '--plan', 'port-forward to grafana, read only', '--needs', 'observe/namespace/lab/monitoring']);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    const t = (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body.templates.find((x) => x.name.startsWith('asked-'))!;
    expect(t.readOnly).toBeFalsy();
    expect(t).toMatchObject({ tools: expect.arrayContaining(['kubectl']), profiles: [{ operation: 'observe', asset: { kind: 'namespace', name: 'lab/monitoring' } }] });

    const asked = await skill(b.a, creds, ['bastion', '--template', t.name, '--targets', 'lab/monitoring/svc/grafana:3000', '--why', 'Read the lab dashboards']);
    expect(asked.code, asked.stdout + asked.stderr).toBe(0);
    expect(asked.stdout).toMatch(new RegExp(`bastion [0-9a-f-]{36} of template ${t.name} is (starting|running)`));
    expect(asked.stdout).toContain('lab/monitoring/svc/grafana:3000 on 127.0.0.1:20000 in the box');

    const box = [...b.runtime.boxes.values()].find((c) => c.spec.name.startsWith(`hopper-bastion-${t.name}-`))!;
    expect(box).toBeDefined();
    const log = join(homeOf(box.spec.name), 'kubectl.log');
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('port-forward'), { timeoutMs: 10_000 });
    expect(readFileSync(log, 'utf8')).toContain(`kubectl --context lab-monitoring --namespace monitoring port-forward --address 127.0.0.1 svc/grafana 20000:3000 token=${MINTED_KUBE_TOKEN}`);
    expect(JSON.stringify(box.spec.env)).not.toContain(MINTED_KUBE_TOKEN);
    expect(asked.stdout).not.toContain(MINTED_KUBE_TOKEN);

    const status = await skill(b.a, creds, ['bastion']);
    expect(status.stdout).toMatch(/is running/);
    const stopped = await skill(b.a, creds, ['bastion', 'stop']);
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
    await waitFor(() => !b.runtime.boxes.has(box.spec.name), { timeoutMs: 10_000 });
    await waitFor(async () => (await skill(b.a, creds, ['bastion'])).stdout.includes('ended'), { timeoutMs: 10_000 });
    expect(b.runtime.volumes.size).toBe(0);

    const events: DomainEvent[] = (await b.a.events()).filter((e) => e.jobId === jobId);
    expect(events.find((e) => e.type === 'vault.minted')?.data).toMatchObject({ kind: 'kube', operation: 'observe', asset: { kind: 'namespace', name: 'lab/monitoring' }, machine: box.spec.name, template: t.name });
    expect(events.find((e) => e.type === 'bastion.started')?.data).toMatchObject({ template: t.name, box: box.spec.name, targets: ['lab/monitoring/svc/grafana:3000'] });
    expect(events.find((e) => e.type === 'bastion.ended')?.data).toMatchObject({ box: box.spec.name, reason: 'stopped', by: 'job' });
    await waitFor(async () => (await b.a.events()).some((e) => e.type === 'vault.unbound' && (e.data as { box?: string }).box === box.spec.name), { timeoutMs: 10_000 });
    expect(JSON.stringify(await b.a.events())).not.toContain(MINTED_KUBE_TOKEN);
  });
});
