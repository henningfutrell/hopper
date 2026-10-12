// Issue #871 part 3: scripts/out-of-band-collector.ts, the ready-made read-only check. Each test runs the script with
// fake `kubectl`, `terraform` and `aws` first on its PATH, and a fake hopper on loopback that answers the refresh and
// takes the report, so nothing here reaches a cluster, a cloud or a real hopper.
//
// Feature: a scheduled check outside the hopper reports what it found, and keeps its place
//   Scenario: with a grant's refresh token, it trades it, keeps the new one, and reports every signal to the collector route
//   Scenario: a second run reads the audit log from where the first ended
//   Scenario: inside a hopper job, it reports with the job's token to the job's route
//   Scenario: a source that fails is said, the others still report, and the run does not move its place
//   Scenario: with --dry-run it prints the signals and sends nothing
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'out-of-band-collector.ts');

let dir: string;
let bin: string;
let server: Server;
let url: string;
let calls: { path: string; auth?: string; body: Record<string, unknown> }[];
let refreshes: string[];

const argo = JSON.stringify({ items: [{ metadata: { namespace: 'argocd', name: 'web' }, status: { sync: { status: 'OutOfSync' } } }] });
const audit = (id: string, at: string) => JSON.stringify({
  kind: 'Event', auditID: id, stage: 'ResponseComplete', verb: 'delete', user: { username: 'alice' },
  objectRef: { resource: 'configmaps', namespace: 'web', name: 'cfg' }, responseStatus: { code: 200 }, requestReceivedTimestamp: at, stageTimestamp: at,
});

function tool(name: string, script: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

type Run = { status: number | null; stdout: string; stderr: string };
/** Async, not spawnSync: the fake hopper answers in this process. */
function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d; });
    p.stderr.on('data', (d: Buffer) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jh-oob-collector-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  calls = [];
  refreshes = [];
  tool('kubectl', `echo '${argo}'`);
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      if (req.url === '/ui/auth/token/refresh') {
        refreshes.push(body.refresh as string);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'hopper_at_1', expiresAt: '2026-10-12T13:00:00Z', refresh: `hopper_rt_${refreshes.length + 1}` }));
        return;
      }
      calls.push({ path: req.url!, auth: req.headers.authorization, body });
      const n = (body.signals as unknown[]).length;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ recorded: new Array(n).fill({}), inBand: [], known: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('scripts/out-of-band-collector.ts', () => {
  it('trades the refresh token, keeps the new one (mode 600), and reports to the collector route', async () => {
    const state = join(dir, 'state.json');
    const r = await run(['--hopper', url, '--state', state, '--argo'], { HOPPER_REFRESH_TOKEN: 'hopper_rt_1' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(refreshes).toEqual(['hopper_rt_1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/ui/api/out-of-band/signals', auth: 'Bearer hopper_at_1' });
    expect(calls[0]!.body.signals).toEqual([expect.objectContaining({ source: 'gitops', key: 'argocd:argocd/web', what: 'OutOfSync' })]);
    expect(r.stdout).toContain('1 recorded, 0 in band, 0 reported before');
    const kept = JSON.parse(readFileSync(state, 'utf8')) as { refresh: string; lastRun: string };
    expect(kept.refresh).toBe('hopper_rt_2');
    expect(Date.parse(kept.lastRun)).not.toBeNaN();
    expect(statSync(state).mode & 0o777).toBe(0o600);

    // The next run uses the kept refresh token, not the variable, and reads the audit log from where this one ended.
    const log = join(dir, 'audit.log');
    writeFileSync(log, [audit('old', '2020-01-01T00:00:00Z'), audit('new', '2099-01-01T00:00:00Z')].join('\n'));
    const again = await run(['--hopper', url, '--state', state, '--kube-audit', log], { HOPPER_REFRESH_TOKEN: 'hopper_rt_1' });
    expect(again.status, again.stderr).toBe(0);
    expect(refreshes).toEqual(['hopper_rt_1', 'hopper_rt_2']);
    expect((calls[1]!.body.signals as { key: string }[]).map((s) => s.key)).toEqual(['new']);
  });

  it('inside a hopper job, reports with the job\'s token to the job\'s route, with no state', async () => {
    writeFileSync(join(dir, 'token'), 'job-proxy-token\n');
    const r = await run(['--argo'], { HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token') });
    expect(r.status, r.stderr).toBe(0);
    expect(refreshes).toEqual([]);
    expect(calls[0]).toMatchObject({ path: '/job/infra-signals', auth: 'Bearer job-proxy-token' });
  });

  it('says which source failed, reports the others, keeps its place, and exits 1', async () => {
    tool('terraform', 'case "$*" in *plan*) echo "Error: no credentials" >&2; exit 1;; esac; exit 0');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ refresh: 'hopper_rt_1', lastRun: '2026-10-12T11:00:00.000Z' }));
    const r = await run(['--hopper', url, '--state', state, '--argo', '--terraform', 'infra']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('terraform infra');
    expect(r.stderr).toContain('Error: no credentials');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ refresh: 'hopper_rt_2', lastRun: '2026-10-12T11:00:00.000Z' });
  });

  it('reports a terraform plan that is not empty, and CloudTrail writes, through the tools', async () => {
    tool('terraform', 'case "$*" in *plan*) echo "Plan: 1 to add, 0 to change, 0 to destroy."; exit 2;; esac; exit 0');
    tool('aws', `echo '${JSON.stringify({ Events: [{ EventId: 'e-1', EventName: 'PutBucketPolicy', EventSource: 's3.amazonaws.com', EventTime: '2026-10-12T11:30:00+00:00', Username: 'root', CloudTrailEvent: '{"readOnly":false}' }] })}'`);
    const r = await run(['--hopper', url, '--terraform', 'infra', '--cloudtrail', 'eu-west-1', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls).toEqual([]);
    const signals = JSON.parse(r.stdout) as { source: string; what: string }[];
    expect(signals).toEqual([
      expect.objectContaining({ source: 'terraform-plan', what: 'Plan: 1 to add, 0 to change, 0 to destroy.' }),
      expect.objectContaining({ source: 'cloudtrail', what: 's3:PutBucketPolicy', who: 'root' }),
    ]);
  });

  it('refuses to run with no source, or with no way to sign in', async () => {
    expect((await run(['--hopper', url])).stderr).toContain('name at least one source');
    const r = await run(['--hopper', url, '--argo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--state');
  });
});
