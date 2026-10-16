// Issues #1004 and #1349, through the real composition root, the real HTTP server and the real `hopper-skill` and
// `hopper-step`: a job on a seat asks for a sandbox, its runs are approved, and each command it runs as a box step runs in
// a sandbox of its own, made for the step and burned after it. No box waits between steps, and none joins as a machine.
// The container runtime is a double at its port whose one-shot containers run the real scripts under `sh` with fake
// cloud tools that answer only with the minted credentials (test/support/read-only-check.ts); STS is faked on loopback;
// OpenFGA is a double at its seam.
//
// Feature: box steps, each in a sandbox of its own
//   Scenario: a seat job runs two steps of its approved template; each gets a new sandbox, burned after it
//     Given the read policy holds aws-role/123456789012/*, and sandbox YOLO
//     When a job asks for a sandbox of read/aws-role/123456789012/readonly and its template's check passes
//     Then the answer says its runs are approved and how to run each command as a box step; no box starts
//     And `hosts` lists the template as a box this job's steps may name
//     When the job runs `box T --input plan --command … --output result.txt --into out`, twice
//     Then each step runs in a new sandbox of T with the minted session, and its output, exit code and outputs come back
//     And no container, volume or machine is left; each sandbox run is in the ledger with its job, step, template,
//       outcome and when it was destroyed
//   Scenario: a template this job has no approved sandbox of, or a --secret, is refused
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxesView } from '../../src/domain/machines.ts';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { STEP_NOT_RUN, STEP_SCRIPT } from '../../src/windows-steps/script.ts';
import { MINTED_AWS } from '../support/fake-mint-apis.ts';
import { ACCOUNT, boot, runningJob, skill, stopAll, type Booted, type Run } from '../support/read-only-check.ts';

afterEach(stopAll);

const NEEDS = `read/aws-role/${ACCOUNT}/readonly`;
const ASK = ['--why', 'Check which role the report runs as'];

/** A seat job whose sandbox runs of a read template are approved under YOLO: its credentials dir, its id, the template. */
async function approvedJob(): Promise<{ b: Booted; creds: string; jobId: string; template: string; answer: string }> {
  const b = await boot([`aws-role/${ACCOUNT}/*`]);
  // Each sandbox's home is a directory of its own (as its home volume): its script runs there, and its files are copied there.
  const homeOf = (name: string): string => { const h = join(b.cloud.dir, `home-${name}`); mkdirSync(h, { recursive: true }); return h; };
  const run = b.cloud.runScript;
  b.runtime.runScript = (spec) => run({ ...spec, env: { ...spec.env, HOME: homeOf(spec.name) } });
  b.runtime.copyIn = async (id, dir, tar) => {
    const c = [...b.runtime.boxes.values()].find((x) => x.id === id)!;
    const to = dir.replace(HOME, homeOf(c.spec.name));
    mkdirSync(to, { recursive: true });
    execFileSync('tar', ['-xf', tar, '-C', to]);
  };
  expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
  const creds = await runningJob(b.a);
  writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
  const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
  // The template waits for its read-only check: the check pass runs it, then the ask is answered.
  const first = await skill(b.a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
  expect(first.code, first.stdout + first.stderr).not.toBe(0);
  await b.a.app.sandboxes.check();
  const asked = await skill(b.a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
  expect(asked.code, asked.stdout + asked.stderr).toBe(0);
  const v = (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;
  const request = v.sandboxRequests!.find((r) => r.jobId === jobId)!;
  expect(request).toMatchObject({ state: 'approved' });
  return { b, creds, jobId, template: request.template, answer: asked.stdout };
}

function step(b: Booted, creds: string, args: string[], cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn('sh', [join(creds, 'step'), ...args], { cwd, env: { PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(creds, 'token'), TMPDIR: b.cloud.dir } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const sandboxesRun = (b: Booted) => [...b.runtime.ran.values()].filter((s) => s.labels[NEED_LABEL] !== undefined);
const ofJob = async (b: Booted, jobId: string): Promise<DomainEvent[]> => (await b.a.events()).filter((e) => e.jobId === jobId);

describe('box steps, each in a sandbox of its own (issues #1004, #1349)', () => {
  it('each step of the approved template runs in a new sandbox, burned after it; nothing joins as a machine', async () => {
    const { b, creds, jobId, template, answer } = await approvedJob();
    expect(answer).toContain(`the sandbox runs of template ${template} are approved for this job`);
    expect(answer).toContain(`sh "$HOPPER_STEP" box ${template} --command`);
    expect(answer).toContain('never joins the hopper as a machine');
    // The approval started nothing: no sandbox box, no sandbox record.
    expect(b.runtime.boxes.size).toBe(0);
    expect(b.a.app.instance.sandboxes.list()).toEqual([]);

    const hosts = await step(b, creds, ['hosts']);
    expect(hosts.code, hosts.stderr).toBe(0);
    expect(hosts.stdout).toMatch(new RegExp(`^box ${template}  template ${template}$`, 'm'));

    const work = join(b.cloud.dir, 'seat-work');
    mkdirSync(join(work, 'plan'), { recursive: true });
    writeFileSync(join(work, 'plan', 'role.json'), '{"role":"report"}\n');
    const one = await step(b, creds, ['box', template, '--input', 'plan', '--command', 'aws sts get-caller-identity; cat plan/role.json > result.txt; exit 4', '--output', 'result.txt', '--into', 'out'], work);
    expect(one.code, one.stdout + one.stderr).toBe(4);
    expect(one.stdout).toContain('"Arn":"arn:aws:sts::123456789012:assumed-role/hopper-read/s"');
    expect(readFileSync(join(work, 'out', 'result.txt'), 'utf8')).toBe('{"role":"report"}\n');
    const two = await step(b, creds, ['box', template, '--command', 'test ! -e plan/role.json && echo fresh']);
    expect(two.code, two.stdout + two.stderr).toBe(0);
    expect(two.stdout).toContain('fresh');

    // Two steps, two sandboxes of the template, each with the minted session in its environment; none left after.
    const ran = sandboxesRun(b);
    expect(ran).toHaveLength(2);
    expect(ran[0]!.name).not.toBe(ran[1]!.name);
    for (const s of ran) {
      expect(s.name).toMatch(new RegExp(`^hopper-need-${template}-`));
      expect(s.env.AWS_SESSION_TOKEN).toBe(MINTED_AWS.SessionToken);
    }
    expect(b.runtime.boxes.size).toBe(0);
    expect(b.runtime.volumes.size).toBe(0);
    const machines = (await b.a.api<{ machines: { id: string }[] }>('GET', '/api/machines')).body.machines;
    expect(machines.map((m) => m.id).filter((id) => id.startsWith('hopper-'))).toEqual([]);

    // The ledger: each sandbox run with its job, step, template, outcome, and when it was destroyed.
    const events = await ofJob(b, jobId);
    const started = events.filter((e) => e.type === 'step.started').map((e) => e.data as { step: string; box: string });
    const view = (await b.a.api<SandboxesView>('GET', '/api/sandboxes', undefined, { 'x-hopper-session': b.token })).body;
    expect(view.problems).toEqual([]);
    expect(view.runs).toHaveLength(2);
    for (const run of view.runs) {
      expect(started).toContainEqual(expect.objectContaining({ step: run.id, box: run.box }));
      expect(run).toMatchObject({ jobId, template, machine: 'local', startedAt: expect.any(String), endedAt: expect.any(String), destroyedAt: expect.any(String) });
    }
    expect(view.runs.map((r) => [r.outcome, r.exit]).sort()).toEqual([['failed', 4], ['succeeded', 0]]);
  });

  it('a template this job has no approved sandbox of, or a --secret, is refused', async () => {
    const { b, creds, jobId, template } = await approvedJob();
    const other = await step(b, creds, ['box', 'someone-else', '--command', 'true']);
    expect(other.code).toBe(STEP_NOT_RUN);
    expect(other.stdout).toContain(`no: this job has no approved sandbox of template someone-else. Its approved sandboxes: ${template}.`);
    expect((await ofJob(b, jobId)).find((e) => e.type === 'step.refused')?.data).toMatchObject({ box: 'someone-else' });
    const secret = await step(b, creds, ['box', template, '--secret', 'AWS_KEY', '--command', 'true']);
    expect(secret.code).toBe(2);
    expect(secret.stderr).toContain('never a vault secret by name');
    expect(sandboxesRun(b)).toHaveLength(0);
  });
});

