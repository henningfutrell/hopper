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
//   Scenario (part 5): the template waits for its read-only check, which runs with the observe minted for it and passes
//   Scenario (part 2): the job's `hopper-relay` holds a local port joined to a target of its bastion through the hopper's
//     relay, a command in the box that reaches the forward; a target the bastion does not forward to is refused
//   Scenario: a person sees the job's bastion in the vault's view, never its token, and stops it there
//   Scenario (part 3): the template names its bastion target, approved with it; Access allows each connection, and each
//     is a `bastion.relayed` event on the job's timeline
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { RELAY_CLIENT, RELAY_SCRIPT } from '../../src/sandbox/relay-script.ts';
import { MINTED_KUBE_TOKEN } from '../support/fake-mint-apis.ts';
import { boot, runningJob, skill, stopAll, type Booted } from '../support/read-only-check.ts';
import { waitFor } from '../support/wait.ts';

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
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
  const outputs = new Map<string, string>();
  // A check box (part 5) runs the check's script with the fake cloud tools, as in the read-only check's tests.
  const check = b.runtime.runScript;
  b.runtime.runScript = (spec) => (spec.name.startsWith('hopper-check-') && check ? check(spec) : new Promise((resolve) => {
    const child = spawn('sh', ['-c', spec.script ?? ''], { env: { ...spec.env, HOME: homeOf(spec.name), PATH: `${bin}:${process.env.PATH}` }, detached: true });
    running.set(spec.name, child);
    children.push(child);
    const add = (d: Buffer): void => { outputs.set(spec.name, (outputs.get(spec.name) ?? '') + d.toString()); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('exit', (code) => resolve({ exit: code ?? 143, output: outputs.get(spec.name) ?? '' }));
  }));
  // The box's output while it runs, as a runtime's log gives it: the bastion reads each forward's state there (issue #2484).
  const logs = b.runtime.logs.bind(b.runtime);
  b.runtime.logs = async (id) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id);
    return c && running.has(c.spec.name) ? outputs.get(c.spec.name) ?? '' : logs(id);
  };
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

/**
 * The job asks for a template with an observe on lab/monitoring. It waits for the template's read-only check (part 5),
 * which the check pass runs with the observe minted for it: exec and a Secret read are refused, so it passes.
 */
async function observeTemplate(b: Booted, creds: string): Promise<VaultView['templates'][number]> {
  const made = await skill(b.a, creds, ['sandbox-template', '--why', 'Read the lab dashboards', '--plan', 'port-forward to grafana, read only', '--needs', 'observe/namespace/lab/monitoring', '--targets', 'lab/monitoring/svc/grafana:3000']);
  expect(made.stdout + made.stderr).toContain('waiting for the read-only check of asked-');
  await b.a.app.sandboxes.check();
  const t = (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body.templates.find((x) => x.name.startsWith('asked-'))!;
  expect(t.readOnly).toBe(true);
  expect(t.check, JSON.stringify(t.check)).toMatchObject({ state: 'passed' });
  expect(t.check!.probes.filter((p) => p.id.startsWith('observe.')).map((p) => [p.id, p.operation, p.outcome])).toEqual([
    ['observe.exec', 'observe', 'denied'], ['observe.secret-read', 'observe', 'denied'],
  ]);
  return t;
}

describe('bastions (issue #2146)', () => {
  it('under YOLO a job starts a bastion of its observe template; the token stays in the box; the job stops it', async () => {
    const b = await boot([]);
    const homeOf = bastionBoxes(b);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;

    const t = await observeTemplate(b, creds);
    expect(t).toMatchObject({ tools: expect.arrayContaining(['kubectl']), profiles: [{ operation: 'observe', asset: { kind: 'namespace', name: 'lab/monitoring' } }] });

    const asked = await skill(b.a, creds, ['bastion', '--template', t.name, '--targets', 'lab/monitoring/svc/grafana:3000', '--why', 'Read the lab dashboards']);
    expect(asked.code, asked.stdout + asked.stderr).toBe(0);
    expect(asked.stdout).toMatch(new RegExp(`bastion [0-9a-f-]{36} of template ${t.name} is (starting|running)`));
    expect(asked.stdout).toContain('lab/monitoring/svc/grafana:3000 on a port kubectl picks in the box');

    const box = [...b.runtime.boxes.values()].find((c) => c.spec.name.startsWith(`hopper-bastion-${t.name}-`))!;
    expect(box).toBeDefined();
    const log = join(homeOf(box.spec.name), 'kubectl.log');
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('port-forward'), { timeoutMs: 10_000 });
    expect(readFileSync(log, 'utf8')).toContain(`kubectl --context lab-monitoring --namespace monitoring port-forward --address 127.0.0.1 svc/grafana :3000 token=${MINTED_KUBE_TOKEN}`);
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

  it('a person sees the job\'s bastion in the vault\'s view and stops it there', async () => {
    const b = await boot([]);
    bastionBoxes(b);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
    const t = await observeTemplate(b, creds);
    const asked = await skill(b.a, creds, ['bastion', '--template', t.name, '--targets', 'lab/monitoring/svc/grafana:3000', '--why', 'Read the lab dashboards']);
    expect(asked.code, asked.stdout + asked.stderr).toBe(0);
    const box = [...b.runtime.boxes.values()].find((c) => c.spec.name.startsWith(`hopper-bastion-${t.name}-`))!;

    const view = (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;
    expect(view.bastions).toMatchObject([{ jobId, template: t.name, box: box.spec.name, targets: [{ target: 'lab/monitoring/svc/grafana:3000' }] }]);
    expect(JSON.stringify(view.bastions)).not.toContain(MINTED_KUBE_TOKEN);

    const stopped = await b.a.ui('/ui/api/bastions/stop', { job: jobId }, { token: b.token });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    await waitFor(() => !b.runtime.boxes.has(box.spec.name), { timeoutMs: 10_000 });
    await waitFor(async () => ((await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body.bastions ?? []).length === 0, { timeoutMs: 10_000 });
    const ended = (await b.a.events()).find((e) => e.type === 'bastion.ended' && e.jobId === jobId);
    expect(ended?.data).toMatchObject({ box: box.spec.name, reason: 'stopped', by: expect.stringMatching(/^(?!job$).+/) });
    expect((await skill(b.a, creds, ['bastion'])).stdout).toContain('ended');

    const again = await b.a.ui('/ui/api/bastions/stop', { job: jobId }, { token: b.token });
    expect(again.status).toBe(404);
  });

  it('the job\'s hopper-relay joins a local port to a target of its bastion; another target is refused', async () => {
    const b = await boot([]);
    bastionBoxes(b);
    // The forward in the box: a server on this machine's loopback that answers each line.
    const forward = createServer((c) => {
      c.on('data', (d: Buffer) => { for (const line of d.toString().split('\n').filter(Boolean)) c.write(`grafana got ${line}\n`); });
      c.on('error', () => undefined);
    });
    servers.push(forward);
    await new Promise<void>((r) => forward.listen(0, '127.0.0.1', () => r()));
    const started: { box: string; cmd: readonly string[] }[] = [];
    // The box's runtime starts the relay's real connect command here, its port the forward's.
    b.runtime.pipe = async (id, cmd) => {
      started.push({ box: id, cmd });
      const child = spawn(cmd[0]!, [...cmd.slice(1, -1), String((forward.address() as AddressInfo).port)]);
      children.push(child);
      const d = new Duplex({
        read() { child.stdout.resume(); },
        write(chunk: Buffer, _e, done) { child.stdin.write(chunk, done); },
        final(done) { child.stdin.end(); done(); },
        destroy(e, done) { child.kill(); done(e); },
      });
      child.stdin.on('error', () => undefined);
      child.stdout.on('data', (x: Buffer) => { if (!d.push(x)) child.stdout.pause(); });
      child.stdout.on('end', () => d.push(null));
      return Object.assign(d, { stderr: () => '' });
    };
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    writeFileSync(join(creds, 'relay'), RELAY_SCRIPT, { mode: 0o700 });
    writeFileSync(join(creds, 'relay.mjs'), RELAY_CLIENT, { mode: 0o600 });
    const t = await observeTemplate(b, creds);
    const asked = await skill(b.a, creds, ['bastion', '--template', t.name, '--targets', 'lab/monitoring/svc/grafana:3000', '--why', 'Read the lab dashboards']);
    expect(asked.code, asked.stdout + asked.stderr).toBe(0);
    await waitFor(async () => (await skill(b.a, creds, ['bastion'])).stdout.includes('is running'), { timeoutMs: 10_000 });

    const client = 'const s = require("node:net").connect(Number(process.env.HOPPER_RELAY_PORT), "127.0.0.1", () => s.write("one\\ntwo\\n")); let o = ""; s.on("data", (d) => { o += d; if (o.split("\\n").length > 2) { process.stdout.write(o); s.destroy(); } });';
    const used = await relay(b, creds, ['lab/monitoring/svc/grafana:3000', '--', process.execPath, '-e', client]);
    expect(used.code, used.stderr).toBe(0);
    expect(used.stdout).toBe('grafana got one\ngrafana got two\n');
    expect(used.stderr).toMatch(/^hopper-relay: lab\/monitoring\/svc\/grafana:3000 on 127\.0\.0\.1:\d+$/m);
    const box = [...b.runtime.boxes.values()].find((c) => c.spec.name.startsWith(`hopper-bastion-${t.name}-`))!;
    // The first connection checks the target; the second is the command's.
    expect(started).toHaveLength(2);
    expect(started.every((x) => x.box === box.id && x.cmd.at(-1) === '20000')).toBe(true);
    await waitFor(async () => (await b.a.events()).filter((e) => e.type === 'bastion.relayed').length === 2, { timeoutMs: 10_000 });
    expect((await b.a.events()).filter((e) => e.type === 'bastion.relayed').map((e) => (e.data as { target: string }).target)).toEqual(['lab/monitoring/svc/grafana:3000', 'lab/monitoring/svc/grafana:3000']);

    const other = await relay(b, creds, ['lab/monitoring/svc/loki:3100', '--', 'true']);
    expect(other).toMatchObject({ code: 1, stdout: '' });
    expect(other.stderr).toBe('hopper-relay: the job\'s bastion forwards to lab/monitoring/svc/grafana:3000; not to lab/monitoring/svc/loki:3100\n');
    expect(started).toHaveLength(2);

    writeFileSync(join(creds, 'token'), 'not-a-token\n');
    const stranger = await relay(b, creds, ['lab/monitoring/svc/grafana:3000', '--', 'true']);
    expect(stranger).toMatchObject({ code: 1, stderr: 'hopper-relay: the token is not a job\'s of this hopper. A job connects with its own HOPPER_TOKEN_FILE.\n' });
    expect(started).toHaveLength(2);
  });

  it('answers an HTTP request whose forward closes with no answer 502, naming the target, never an empty reply (issue #2474)', async () => {
    const b = await boot([]);
    bastionBoxes(b);
    // The box's connect command: it reads the request, then ends with no byte back, as kubectl does when its stream fails.
    b.runtime.pipe = async () => {
      const d = new Duplex({ read() {}, write(_c, _e, done) { done(); setImmediate(() => d.push(null)); } });
      return Object.assign(d, { stderr: () => '' });
    };
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    writeFileSync(join(creds, 'relay'), RELAY_SCRIPT, { mode: 0o700 });
    writeFileSync(join(creds, 'relay.mjs'), RELAY_CLIENT, { mode: 0o600 });
    const t = await observeTemplate(b, creds);
    expect((await skill(b.a, creds, ['bastion', '--template', t.name, '--targets', 'lab/monitoring/svc/grafana:3000', '--why', 'Read the lab dashboards'])).code).toBe(0);
    await waitFor(async () => (await skill(b.a, creds, ['bastion'])).stdout.includes('is running'), { timeoutMs: 10_000 });
    const client = 'require("node:http").get(`http://127.0.0.1:${process.env.HOPPER_RELAY_PORT}/-/ready`, (r) => { let o = ""; r.on("data", (d) => { o += d; }); r.on("end", () => process.stdout.write(`${r.statusCode} ${o}`)); }).on("error", (e) => { process.stdout.write(e.message); });';
    const used = await relay(b, creds, ['lab/monitoring/svc/grafana:3000', '--', process.execPath, '-e', client]);
    expect(used.code, used.stderr).toBe(0);
    expect(used.stdout).toBe('502 no: the bastion\'s forward to lab/monitoring/svc/grafana:3000 closed the connection with no answer. See its output with sh "$HOPPER_SKILL" bastion\n');
  });
});

function relay(b: Booted, creds: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('sh', [join(creds, 'relay'), ...args], { env: { PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(creds, 'token') } });
    children.push(p);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
