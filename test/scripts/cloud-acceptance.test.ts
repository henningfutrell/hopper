// Issue #866: the real-cloud acceptance run, for an outside tester in their own environment with their own credentials
// (scripts/cloud-acceptance.ts, docs/cloud-acceptance.md). One command drives the tester's hopper through its operator
// CLI: it reads the vault, mint-tests each asset, asks for a template in plain words, waits for its approval and its
// read-only check, and writes a masked report. `collect` reads the reports back. Here the hopper CLI is a double: nothing
// reaches a cloud.
//
// Feature: a real-cloud acceptance run anyone can run and report
//   Scenario: a run whose mint tests pass and whose read-only check passes passes, with each tool's reads and writes
//   Scenario: the template is asked for in plain words that name each asset
//   Scenario: a template that waits for a person is waited for, then checked
//   Scenario: a check that ended before the run is run again, so the report is of this run
//   Scenario: a write that went through fails the run, and names the tool
//   Scenario: a hopper that cannot be reached fails the run, and the other steps are skipped
//   Scenario: a tool no asset covers is skipped, with what to name to cover it
//   Scenario: the report names no account, role, cluster, key or address of the tester
//   Scenario: collect reads reports from report files and from a GitHub issue list, and sums them up per tool
//   Scenario: the command writes report.json and report.md, and exits 1 when the run failed
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect, markdown, needsInWords, run, type Answer, type Assets, type Report } from '../../scripts/cloud-acceptance.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'cloud-acceptance.ts');

const ASSETS: Assets = { awsRole: '123456789012/readonly', cluster: 'lab-east' };
const SAVED = '2026-10-17T08:00:00.000Z';

const probe = (id: string, asset: string, expect: 'allowed' | 'denied', outcome: string, output = '') =>
  ({ id, asset, expect, outcome, passed: outcome === expect, exit: outcome === 'allowed' ? 0 : 1, output });
const PASSING = [
  probe('aws.caller-identity', 'aws-role/123456789012/readonly', 'allowed', 'allowed', '{"Arn":"arn:aws:sts::123456789012:assumed-role/readonly/hopper-x"}'),
  probe('aws.iam-create-user', 'aws-role/123456789012/readonly', 'denied', 'denied', 'AccessDenied for AKIAABCDEFGHIJKLMNOP'),
  probe('kube.get', 'cluster/lab-east', 'allowed', 'allowed', 'default kube-system'),
  probe('kube.create-namespace', 'cluster/lab-east', 'denied', 'denied', 'is forbidden'),
  probe('helm.list', 'cluster/lab-east', 'allowed', 'allowed', ''),
  probe('helm.install', 'cluster/lab-east', 'denied', 'denied', 'is forbidden'),
];

/** A hopper CLI double: the vault and its one template, which moves on as the run asks and polls. */
function hopper(o: { probes?: unknown[]; approved?: boolean; checkedBefore?: boolean; down?: boolean } = {}) {
  const calls: string[][] = [];
  let approved = o.approved ?? true;
  let check: unknown = o.checkedBefore ? { version: SAVED, state: 'failed', at: SAVED, probes: [] } : undefined;
  let polls = 0;
  const template = () => ({
    name: 'asked-0a1b2c', savedAt: SAVED, readOnly: true, check,
    pending: { secrets: [], image: !approved, profiles: [] },
    ...(approved ? { approval: { image: 'x', secrets: [], by: 'the read policy', at: SAVED } } : {}),
  });
  const ok = (v: unknown): Answer => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
  const call = (args: string[]): Answer => {
    calls.push(args);
    if (o.down) return { status: 1, stdout: '', stderr: 'hopper: connect ECONNREFUSED 10.1.2.3:5432\n' };
    const [a, b] = args;
    if (a === 'vault' && b === undefined) {
      return ok({ secrets: [{ name: 'AWS_MINT', mints: { kind: 'aws-account', name: '123456789012' } }, { name: 'KUBE_MINT', mints: { kind: 'cluster', name: 'lab-east' } }], templates: [template()] });
    }
    if (a === 'vault' && b === 'mint-test') return ok({ kind: args[2]!.startsWith('aws') ? 'aws' : 'kube', identity: { arn: 'arn:aws:sts::123456789012:assumed-role/readonly/hopper-mint-test' }, user: { username: 'system:serviceaccount:lab-east:viewer' } });
    if (a === 'template' && b === 'request') return ok({ template: 'asked-0a1b2c', ready: approved, text: approved ? 'ready' : 'waits for a person' });
    if (a === 'template' && b === 'check') {
      check = undefined;
      return ok({});
    }
    if (a === 'template' && b === 'approve') {
      approved = true;
      return ok({});
    }
    if (a === 'template' && b === 'list') {
      polls += 1;
      // A person approves it at the second poll; the check runs, then ends at the next poll.
      if (!approved && polls >= 2) approved = true;
      else if (approved && check === undefined) check = { version: SAVED, state: 'running', at: SAVED, probes: [] };
      else if (approved && (check as { state: string }).state === 'running') check = { version: SAVED, state: (o.probes ?? PASSING).every((p) => (p as { passed: boolean }).passed) ? 'passed' : 'failed', at: SAVED, probes: o.probes ?? PASSING };
      return ok([template()]);
    }
    return { status: 2, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
  };
  return { call, calls };
}

const runWith = (h: ReturnType<typeof hopper>, assets: Assets = ASSETS): Promise<Report> =>
  run({ hopper: h.call, assets, waitMs: 60_000, pollMs: 1, now: () => new Date(SAVED), sleep: async () => undefined, say: () => undefined });

const step = (r: Report, id: string) => r.steps.find((s) => s.id === id);

describe('the cloud acceptance run (issue #866)', () => {
  it('passes when the mint tests and the read-only check pass, with each tool\'s reads and writes', async () => {
    const r = await runWith(hopper());
    expect(r.passed).toBe(true);
    expect(step(r, 'hopper.reach')?.status).toBe('passed');
    expect(step(r, 'vault.minting.aws')?.status).toBe('passed');
    expect(step(r, 'vault.minting.cluster')?.status).toBe('passed');
    expect(step(r, 'vault.mint-test.aws')?.status).toBe('passed');
    expect(step(r, 'vault.mint-test.cluster')?.status).toBe('passed');
    expect(step(r, 'template.request')?.status).toBe('passed');
    expect(step(r, 'template.approved')?.status).toBe('passed');
    expect(step(r, 'check.ended')?.status).toBe('passed');
    expect(step(r, 'probe.aws.iam-create-user')).toMatchObject({ tool: 'aws', status: 'passed' });
    expect(step(r, 'probe.helm.install')).toMatchObject({ tool: 'helm', status: 'passed' });
    expect(r.tools).toMatchObject({ aws: 'passed', kubectl: 'passed', helm: 'passed', terraform: 'skipped' });
  });

  it('asks for the template in plain words that name each asset', async () => {
    const h = hopper();
    await runWith(h, { ...ASSETS, namespace: 'lab-east/web', workspace: 'infra-ro' });
    const request = h.calls.find((c) => c[0] === 'template' && c[1] === 'request')!;
    expect(request[2]).toBe('--needs');
    expect(request[3]).toBe(needsInWords({ ...ASSETS, namespace: 'lab-east/web', workspace: 'infra-ro' }));
    expect(request[3]).toContain('role 123456789012/readonly');
    expect(request[3]).toContain('cluster lab-east');
    expect(request[3]).toContain('namespace lab-east/web');
    expect(request[3]).toContain('workspace infra-ro');
    expect(request[3]).not.toMatch(/\b(write|create|delete|apply)\b/);
  });

  it('waits for a person to approve the template, then waits for its check', async () => {
    const said: string[] = [];
    const h = hopper({ approved: false });
    const r = await run({ hopper: h.call, assets: ASSETS, waitMs: 60_000, pollMs: 1, now: () => new Date(SAVED), sleep: async () => undefined, say: (t) => said.push(t) });
    expect(r.passed).toBe(true);
    expect(said.join('\n')).toContain('hopper template approve asked-0a1b2c');
  });

  it('runs a check that ended before the run again', async () => {
    const h = hopper({ checkedBefore: true });
    const r = await runWith(h);
    expect(h.calls).toContainEqual(['template', 'check', 'asked-0a1b2c']);
    expect(r.passed).toBe(true);
  });

  it('fails when a write went through, and names the tool', async () => {
    const probes = PASSING.map((p) => (p.id === 'kube.create-namespace' ? probe('kube.create-namespace', 'cluster/lab-east', 'denied', 'allowed', 'namespace/hopper-read-only-check created (server dry run)') : p));
    const r = await runWith(hopper({ probes }));
    expect(r.passed).toBe(false);
    expect(step(r, 'probe.kube.create-namespace')).toMatchObject({ tool: 'kubectl', status: 'failed' });
    expect(r.tools.kubectl).toBe('failed');
    expect(markdown(r)).toContain('| kubectl | failed |');
  });

  it('fails when the hopper cannot be reached, and skips the rest', async () => {
    const r = await runWith(hopper({ down: true }));
    expect(r.passed).toBe(false);
    expect(step(r, 'hopper.reach')?.status).toBe('failed');
    expect(step(r, 'template.request')?.status).toBe('skipped');
    expect(JSON.stringify(r)).not.toContain('10.1.2.3');
  });

  it('skips a tool no asset covers, and says what to name', async () => {
    const r = await runWith(hopper());
    expect(step(r, 'tool.terraform')).toMatchObject({ status: 'skipped' });
    expect(step(r, 'tool.terraform')?.detail).toContain('--terraform-workspace');
  });

  it('names no account, role, cluster, key or address of the tester in the report', async () => {
    const r = await runWith(hopper());
    const text = JSON.stringify(r) + markdown(r);
    for (const leak of ['123456789012', 'lab-east', 'readonly', 'AKIAABCDEFGHIJKLMNOP']) expect(text).not.toContain(leak);
    expect(text).toContain('<account>');
    expect(text).toContain('<cluster>');
  });

  it('refuses a run that names no asset, or a workspace with no AWS role', async () => {
    await expect(runWith(hopper(), {})).rejects.toThrow(/--aws-role|--cluster/);
    // terraform's probes run with the read session of the template's AWS role (design.md "The read-only check").
    await expect(runWith(hopper(), { workspace: 'infra-ro' })).rejects.toThrow(/--terraform-workspace needs --aws-role/);
  });
});

describe('collecting reports (issue #866)', () => {
  it('reads report files and a GitHub issue list, and sums them up per tool', async () => {
    const passed = await runWith(hopper());
    const failed = await runWith(hopper({ probes: PASSING.map((p) => (p.id === 'aws.iam-create-user' ? { ...p, outcome: 'allowed', passed: false } : p)) }));
    const issues = [
      { number: 901, url: 'https://github.com/o/r/issues/901', body: `Some words.\n\n${markdown(failed)}` },
      { number: 902, url: 'https://github.com/o/r/issues/902', body: 'No report in here.' },
    ];
    const out = collect([JSON.stringify(passed), JSON.stringify(issues)]);
    expect(out.reports).toHaveLength(2);
    expect(out.text).toContain('https://github.com/o/r/issues/901');
    expect(out.text).toMatch(/\| aws \| 1 \| 1 \| 0 \|/);
    expect(out.text).toMatch(/\| helm \| 2 \| 0 \| 0 \|/);
    expect(out.text).toMatch(/\| terraform \| 0 \| 0 \| 2 \|/);
    expect(out.unread).toEqual(['https://github.com/o/r/issues/902']);
  });
});

describe('the command (issue #866)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hopper-cloud-acceptance-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake `hopper` CLI on disk: it answers from a JSON file of answers by first two arguments. */
  function fakeHopper(answers: Record<string, unknown>, status = 0): string {
    writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
    const bin = join(dir, 'fake-hopper.ts');
    writeFileSync(bin, `import { readFileSync } from 'node:fs';
const a = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'answers.json'))}, 'utf8'));
const key = process.argv.slice(2, 4).join(' ');
const v = a[key] ?? a[process.argv[2]];
if (${status} !== 0 || v === undefined) { process.stderr.write('hopper: refused ' + key + '\\n'); process.exit(${status} || 2); }
process.stdout.write(JSON.stringify(v));
`);
    chmodSync(bin, 0o755);
    return `${process.execPath} ${bin}`;
  }

  it('writes report.json and report.md, and exits 1 when the run failed', () => {
    const cmd = fakeHopper({}, 1);
    const r = spawnSync(process.execPath, [SCRIPT, 'run', '--cluster', 'lab-east', '--hopper', cmd, '--out', dir, '--wait', '1'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
    expect(report.kind).toBe('hopper-cloud-acceptance');
    expect(report.passed).toBe(false);
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('hopper-cloud-acceptance');
    expect(r.stdout).toContain('issues/new?template=cloud-acceptance.yml');
  });

  it('exits 2 on a bad call', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'run'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--aws-role|--cluster/);
  });
});
