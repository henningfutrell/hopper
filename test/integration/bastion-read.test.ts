// Issue #2146 (the bastion path, part 6), through the real composition root, the real HTTP server and the real
// `hopper-skill`: a job reads Grafana's API through its bastion with a Viewer token that stays in the bastion's box. The
// container runtime is a double at its port whose box runs the bastion's script under `sh` with a fake kubectl, and whose
// pipe starts the read's real command here, its port the fake Grafana's on loopback and its home the box's own; OpenFGA
// is a double at its seam.
//
// Feature: a bastion read
//   Scenario: a job's bastion holds a vault secret only after the job's vault grant, as a file in its box; a bastion read
//     runs there with its header and answers Grafana's body; a write is refused; no token is in the job's answers, the
//     box's environment or an event
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { boot, runningJob, skill, stopAll, type Booted } from '../support/read-only-check.ts';
import { waitFor } from '../support/wait.ts';

const TOKEN = 'glsa_viewer_token_0123456789abcdef';
const GRAFANA = 'lab/monitoring/svc/grafana:3000';
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const c of children.splice(0)) if (c.exitCode === null) try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ }
  await stopAll();
});

/** A fake Grafana on loopback: what it was asked, and a search answer. */
async function grafana(): Promise<{ port: number; seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] }> {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const s = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('[{"uid":"lat","title":"Latency"}]'));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as AddressInfo).port, seen };
}

/** The bastion's box runs its script under `sh` with a kubectl that says it listens, then waits; its pipe runs a command here, in the box's home. */
function boxes(b: Booted, port: number): void {
  const homeOf = (name: string): string => { const h = join(b.cloud.dir, `home-${name}`); mkdirSync(h, { recursive: true }); return h; };
  const bin = join(b.cloud.dir, 'bastion-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\necho "Forwarding from 127.0.0.1:20000 -> 3000"\nexec sleep 600\n');
  chmodSync(join(bin, 'kubectl'), 0o755);
  const check = b.runtime.runScript;
  const running = new Map<string, ChildProcess>();
  const outputs = new Map<string, string>();
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
  b.runtime.pipe = async (id, cmd) => {
    const home = homeOf([...b.runtime.boxes.values()].find((x) => x.id === id)!.spec.name);
    const args = cmd.slice(1).map((a, i) => (i === 3 ? String(port) : a.replace(HOME, home)));
    const child = spawn(cmd[0]!, args);
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (x: Buffer) => { stderr += x.toString(); });
    const d = new Duplex({
      read() { child.stdout.resume(); },
      write(chunk: Buffer, _e, done) { child.stdin.write(chunk, done); },
      final(done) { child.stdin.end(); done(); },
      destroy(e, done) { child.kill(); done(e); },
    });
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (x: Buffer) => { if (!d.push(x)) child.stdout.pause(); });
    child.stdout.on('end', () => d.push(null));
    return Object.assign(d, { stderr: () => stderr });
  };
}

describe('a bastion read (issue #2146, part 6)', () => {
  it('reads Grafana in the bastion\'s box with a token the job never gets', async () => {
    const b = await boot([]);
    const g = await grafana();
    boxes(b, g.port);
    expect((await b.a.ui('/ui/api/vault', { action: 'set', name: 'GRAFANA_VIEWER', value: TOKEN }, { token: b.token })).status).toBe(200);
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
    const view = async () => (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;

    // The template names the secret: a person approves it, then its read-only check passes.
    await skill(b.a, creds, ['sandbox-template', '--why', 'Read the lab dashboards', '--plan', 'read grafana', '--needs', 'observe/namespace/lab/monitoring', '--targets', GRAFANA, '--secrets', 'GRAFANA_VIEWER']);
    const name = (await view()).templates.find((t) => t.name.startsWith('asked-'))!.name;
    for (const body of [{ action: 'approve-template', name }, { action: 'approve-profile', name, operation: 'observe', asset: { kind: 'namespace', name: 'lab/monitoring' } }]) {
      const r = await b.a.ui('/ui/api/vault', body, { token: b.token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    await b.a.app.sandboxes.check();
    const t = (await view()).templates.find((x) => x.name === name)!;
    expect(t, JSON.stringify(t.check)).toMatchObject({ gives: ['GRAFANA_VIEWER'], check: { state: 'passed' } });

    const ask = ['bastion', '--template', name, '--targets', GRAFANA, '--secrets', 'GRAFANA_VIEWER', '--why', 'Read the lab dashboards'];
    const ungranted = await skill(b.a, creds, ask);
    expect(ungranted.code, ungranted.stdout + ungranted.stderr).toBe(1);
    expect(ungranted.stdout).toMatch(/the vault gave no GRAFANA_VIEWER: job [0-9a-f]{8} has no vault grant/);
    expect((await b.a.ui(`/ui/api/jobs/${jobId}/grant-vault`, {}, { token: b.token })).status).toBe(200);
    const asked = await skill(b.a, creds, ask);
    expect(asked.code, asked.stdout + asked.stderr).toBe(0);
    expect(asked.stdout).toContain('It holds the vault secrets GRAFANA_VIEWER for reads in the box');
    await waitFor(async () => (await skill(b.a, creds, ['bastion'])).stdout.includes('is running'), { timeoutMs: 10_000 });

    const read = await skill(b.a, creds, ['bastion', 'read', '--targets', GRAFANA, '--secrets', 'GRAFANA_VIEWER', '--path', '/api/search?query=latency']);
    expect(read.code, read.stdout + read.stderr).toBe(0);
    expect(read.stdout).toBe('[{"uid":"lat","title":"Latency"}]');
    expect(g.seen).toMatchObject([{ method: 'GET', url: '/api/search?query=latency' }]);
    expect(g.seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    const write = await skill(b.a, creds, ['bastion', 'read', '--targets', GRAFANA, '--secrets', 'GRAFANA_VIEWER', '--path', '/api/dashboards/db', '--data', '{"dashboard":{}}']);
    expect(write.code).toBe(1);
    expect(write.stdout).toContain('a read POSTs only to /api/ds/query');
    expect(g.seen).toHaveLength(1);

    const box = [...b.runtime.boxes.values()].find((c) => c.spec.name.startsWith(`hopper-bastion-${name}-`))!;
    expect(JSON.stringify(box.spec.env)).not.toContain(TOKEN);
    for (const r of [ungranted, asked, read, write]) expect(r.stdout + r.stderr).not.toContain(TOKEN);
    const events: DomainEvent[] = await b.a.events();
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(events.find((e) => e.type === 'vault.step_delivered' && e.jobId === jobId)?.data).toMatchObject({ name: 'GRAFANA_VIEWER', host: box.spec.name });
    expect(events.find((e) => e.type === 'bastion.read')?.data).toMatchObject({ target: GRAFANA, method: 'GET', path: '/api/search?query=latency', status: 200 });
  }, 60_000);
});
