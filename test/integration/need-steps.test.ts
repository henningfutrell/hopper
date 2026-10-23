// Issue #1007, through the real composition root, the real HTTP server and the real `hopper-step`: a job on a machine
// that holds no AWS or Kubernetes credential names what one command needs, and the hopper runs that command in a step
// box of a template that covers the needs, with a credential it mints for that step only. The container runtime is a
// double at its port whose one-shot containers run the real scripts under `sh` with fake cloud tools that answer only
// with the minted credentials (test/support/read-only-check.ts); STS and a Kubernetes API are faked on loopback; OpenFGA
// is a double at its seam.
//
// Feature: need steps
//   Scenario: a read need inside the read policy: the template is made and approved by the policy, its read-only check
//     passes, and the step runs with no person; the job's own environment never holds a credential
//     Given the read policy holds aws-role/123456789012/*
//     When a job runs `hopper-step need "read/aws-role/123456789012/readonly" --command "aws sts get-caller-identity"`
//     Then hopper-step waits for the template's read-only check, and asks again by itself
//     When the check pass runs
//     Then the step runs in a need box of that template with the minted AWS session, and its output comes back
//     And the step and the mint are on the job's timeline, the need box as the machine; the box is gone after it
//     When the job runs the same need again
//     Then it runs at once in the same template: no second template, no second check
//   Scenario: a template a person saved that declares the need and more is used: the step is minted only its need
//   Scenario: a write need waits for a person; one approval, and the step goes on with no other action; a change with
//     no approved plan is refused by the apply gate, and nothing is minted
//   Scenario: a write need is one run card (issue #2197): the template it waits on is no card of its own; one notice of
//     the card; one approval of the run card, and the step goes on with no other approval; a declined card tells the step no
//   Scenario: the run card's approval is for its job only (part 3); with allow again it is for every job, and remembered
//   Scenario: sandbox strictness locked for the template (issue #655 part 8): the need step is refused, saying why
//   Scenario: a need the vault mints nothing for is refused, saying why; a bad call is refused before anything runs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, TemplateView, VaultView } from '../../src/domain/types.ts';
import { templateCards } from '../../src/domain/run-cards.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { STEP_SCRIPT } from '../../src/windows-steps/script.ts';
import { MINTED_AWS } from '../support/fake-mint-apis.ts';
import { ACCOUNT, boot, runningJob, stopAll, vault, type Booted, type Run } from '../support/read-only-check.ts';
import { waitFor } from '../support/wait.ts';

afterEach(stopAll);

const READ = `read/aws-role/${ACCOUNT}/readonly`;
const WHY = ['--why', 'Check which role the dig runs as'];

/** Booted, with each need box's script run with a home of its own (as a box's home volume). */
async function bootSteps(policy: string[]): Promise<Booted> {
  const b = await boot(policy);
  const run = b.cloud.runScript;
  b.runtime.runScript = (spec) => run({ ...spec, env: { ...spec.env, HOME: mkdtempSync(join(b.cloud.dir, 'home-')) } });
  return b;
}

/** The job's credentials dir with `hopper-step` beside its token; the job's id from its token's job. */
async function stepJob(b: Booted): Promise<{ creds: string; jobId: string }> {
  const creds = await runningJob(b.a);
  writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
  const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
  return { creds, jobId };
}

/** The job's own environment: no AWS, Kubernetes or terraform variable. */
const jobEnv = (b: Booted, creds: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(creds, 'token'), HOPPER_STEP_POLL_S: '1', TMPDIR: b.cloud.dir });

function step(b: Booted, creds: string, args: string[]): { waiting: Promise<void>; end: Promise<Run> } {
  let told = (): void => {};
  const waiting = new Promise<void>((resolve) => { told = resolve; });
  const end = new Promise<Run>((resolve) => {
    const p = spawn('sh', [join(creds, 'step'), ...args], { env: jobEnv(b, creds) });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.includes('waiting:')) told(); });
    p.on('close', (code) => { told(); resolve({ code: code ?? 1, stdout, stderr }); });
  });
  return { waiting, end };
}

const vaultOf = async (b: Booted): Promise<VaultView> => (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;
const templates = async (b: Booted): Promise<TemplateView[]> => (await vaultOf(b)).templates;
const ofJob = async (b: Booted, jobId: string): Promise<DomainEvent[]> => (await b.a.events()).filter((e) => e.jobId === jobId);
const stepBoxes = (b: Booted) => [...b.runtime.ran.values()].filter((s) => s.labels[NEED_LABEL] !== undefined);

describe('need steps (issue #1007)', () => {
  it('a read need inside the read policy runs with no person, after the read-only check; the same need again reuses the template', async () => {
    const b = await bootSteps([`aws-role/${ACCOUNT}/*`]);
    const { creds, jobId } = await stepJob(b);
    const first = step(b, creds, ['need', READ, ...WHY, '--command', 'aws sts get-caller-identity', '--wait', '60']);
    await first.waiting;
    const [t] = (await templates(b)).filter((x) => x.name.startsWith('asked-'));
    expect(t).toMatchObject({ readOnly: true, approval: { by: 'the read policy' }, profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/readonly` } }] });
    expect(stepBoxes(b)).toHaveLength(0);

    await b.a.app.sandboxes.check();
    const r = await first.end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('"Arn":"arn:aws:sts::123456789012:assumed-role/hopper-read/s"');
    expect(r.stderr).toContain('hopper-step: the template is ready; the step runs now');
    expect(r.stderr).toContain('hopper-step: exit 0');

    // One need box of the template: its image, the step label, the minted session in its environment only; then gone.
    const [box] = stepBoxes(b);
    expect(box!.name).toMatch(new RegExp(`^hopper-need-${t!.name}-`));
    expect(box!.env.AWS_SESSION_TOKEN).toBe(MINTED_AWS.SessionToken);
    expect(box!.script).not.toContain(MINTED_AWS.SessionToken);
    expect(b.runtime.boxes.size).toBe(0);
    expect(b.runtime.volumes.size).toBe(0);

    const events = await ofJob(b, jobId);
    expect(events.find((e) => e.type === 'step.started')?.data).toMatchObject({ box: box!.name, template: t!.name, needs: [READ], command: 'aws sts get-caller-identity' });
    expect(events.find((e) => e.type === 'vault.minted')?.data).toMatchObject({ kind: 'aws', operation: 'read', machine: box!.name, template: t!.name, job: jobId, credential: 'AWS_LAB', renewal: false });
    expect(events.find((e) => e.type === 'step.finished')?.data).toMatchObject({ box: box!.name, exit: 0 });
    expect(JSON.stringify(events)).not.toContain(MINTED_AWS.SessionToken);

    // The same need again: at once, in the same template; no second template, no second check.
    const checks = [...b.runtime.ran.values()].length - 1;
    const again = await step(b, creds, ['need', READ, ...WHY, '--command', 'aws sts get-caller-identity']).end;
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).not.toContain('waiting:');
    expect((await templates(b)).filter((x) => x.name.startsWith('asked-'))).toHaveLength(1);
    expect(stepBoxes(b)).toHaveLength(2);
    expect([...b.runtime.ran.values()].length - 2).toBe(checks);
  });

  it('a template a person saved that declares the need and more is used; the step is minted only its need', async () => {
    const b = await bootSteps([]);
    const role = { kind: 'aws-role', name: `${ACCOUNT}/readonly` };
    expect((await vault(b.a, b.token, { action: 'save-template', name: 'dig', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [{ operation: 'read', asset: role }, { operation: 'read', asset: { kind: 'cluster', name: 'lab' } }] })).status).toBe(200);
    expect((await vault(b.a, b.token, { action: 'approve-template', name: 'dig' })).status).toBe(200);
    const { creds, jobId } = await stepJob(b);
    const r = await step(b, creds, ['need', READ, '--command', 'aws sts get-caller-identity']).end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stepBoxes(b)[0]!.name).toMatch(/^hopper-need-dig-/);
    const minted = (await ofJob(b, jobId)).filter((e) => e.type === 'vault.minted');
    expect(minted.map((e) => (e.data as { asset: unknown }).asset)).toEqual([role]);
    expect(stepBoxes(b)[0]!.env.HOPPER_STEP_KUBECONFIG).toBeUndefined();
    expect((await templates(b)).filter((x) => x.name.startsWith('asked-'))).toHaveLength(0);
  });

  it('sandbox strictness locked for the template (issue #655 part 8): the need step is refused, saying why', async () => {
    const b = await bootSteps([]);
    const role = { kind: 'aws-role', name: `${ACCOUNT}/readonly` };
    expect((await vault(b.a, b.token, { action: 'save-template', name: 'dig', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [{ operation: 'read', asset: role }] })).status).toBe(200);
    expect((await vault(b.a, b.token, { action: 'approve-template', name: 'dig' })).status).toBe(200);
    expect((await b.a.ui('/ui/api/sandbox-strictness', { default: 'standard', radius: {}, templates: { dig: 'locked' } }, { token: b.token })).status).toBe(200);
    const { creds } = await stepJob(b);
    const r = await step(b, creds, ['need', READ, '--command', 'aws sts get-caller-identity']).end;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('sandbox strictness locked for the template dig');
    expect(stepBoxes(b)).toHaveLength(0);
  });

  it('a write need waits for a person; one approval and the step goes on by itself; with no approved plan the apply gate refuses it', async () => {
    const b = await bootSteps([`aws-role/${ACCOUNT}/*`]);
    const { creds, jobId } = await stepJob(b);
    const write = `write/aws-role/${ACCOUNT}/deploy`;
    const run = step(b, creds, ['need', write, ...WHY, '--plan', 'aws ssm put-parameter --name /x (undo: delete it)', '--command', 'aws ssm put-parameter --name /x', '--wait', '60']);
    await run.waiting;
    const [t] = (await templates(b)).filter((x) => x.name.startsWith('asked-'));
    expect(t!.approval).toBeUndefined();
    expect(t).toMatchObject({ pending: { profiles: [{ operation: 'write', asset: { kind: 'aws-role', name: `${ACCOUNT}/deploy` } }] } });

    // One person, one approval of the template and its write: no other action.
    expect((await vault(b.a, b.token, { action: 'approve-template', name: t!.name })).status).toBe(200);
    expect((await vault(b.a, b.token, { action: 'approve-profile', name: t!.name, operation: 'write', asset: { kind: 'aws-role', name: `${ACCOUNT}/deploy` } })).status).toBe(200);
    const r = await run.end;
    expect(r.code).toBe(125);
    expect(r.stdout + r.stderr).toContain(`${write}: no apply without a plan`);
    expect(stepBoxes(b)).toHaveLength(0);
    const events = await ofJob(b, jobId);
    expect(events.find((e) => e.type === 'vault.mint_refused')?.data).toMatchObject({ machine: expect.stringMatching(/^hopper-need-/), template: t!.name, job: jobId });
    expect(events.find((e) => e.type === 'step.refused')?.data).toMatchObject({ reason: expect.stringContaining('no apply without a plan') });
    expect(events.filter((e) => e.type === 'vault.minted')).toHaveLength(0);
  });

  it('a write need is one run card (issue #2197); its one approval starts the step with no other approval in between', async () => {
    const b = await bootSteps([`aws-role/${ACCOUNT}/*`]);
    const { creds, jobId } = await stepJob(b);
    const write = `write/aws-role/${ACCOUNT}/deploy`;
    const plan = 'aws ssm put-parameter --name /x (undo: delete it)';
    const run = step(b, creds, ['need', write, ...WHY, '--plan', plan, '--command', 'aws ssm put-parameter --name /x', '--wait', '60']);
    await run.waiting;

    // Exactly one card waits for a person: the run card, with the job, its words and the access it needs.
    const v = await vaultOf(b);
    const [t] = v.templates.filter((x) => x.name.startsWith('asked-'));
    expect(v.runs).toEqual([expect.objectContaining({ jobId, template: t!.name, purpose: WHY[1], plan, waits: { template: true, run: false } })]);
    expect(templateCards(v.templates, v.runs ?? [])).toEqual([]);
    expect((v.sandboxRequests ?? []).filter((r) => r.state === 'waiting')).toEqual([]);
    expect(t).toMatchObject({ image: expect.any(String), pending: { profiles: [{ operation: 'write' }] } });
    // The run card's notice (part 2), once, on the job's timeline: the notifiers send it.
    expect((await ofJob(b, jobId)).filter((e) => e.type === 'vault.run_card_opened').map((e) => e.data)).toEqual([{ template: t!.name, waits: { template: true, run: false }, purpose: WHY[1] }]);

    // One approval: the template, its write profile and the run. No other approval; the step goes on by itself.
    const approved = await b.a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve-run', job: jobId, template: t!.name }, { token: b.token });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.runs).toEqual([]);
    const r = await run.end;
    expect(r.stderr).toContain('hopper-step: the template is ready; the step runs now');
    // The step ran in a need box; with no approved infra plan the apply gate refuses the write there, as it should.
    expect(r.stdout + r.stderr).toContain(`${write}: no apply without a plan`);
    const events = await ofJob(b, jobId);
    expect(events.find((e) => e.type === 'vault.mint_refused')?.data).toMatchObject({ machine: expect.stringMatching(/^hopper-need-/), template: t!.name, job: jobId });
    // Part 3: with no allow again, the approval is for this job's runs only, and no write approval is remembered.
    const after = await vaultOf(b);
    expect(after.templates.find((x) => x.name === t!.name)).toMatchObject({ approval: { by: expect.any(String), jobs: [jobId] }, pending: { profiles: [] } });
    expect((await b.a.events()).find((e) => e.type === 'vault.approved')?.data).toMatchObject({ template: t!.name, jobs: [jobId] });
    expect(after.rememberedWrites ?? []).toEqual([]);
  });

  it('allow again on a run card (issue #2197 part 3): the approval is for every job, and the write approval is remembered', async () => {
    const b = await bootSteps([]);
    const { creds, jobId } = await stepJob(b);
    const run = step(b, creds, ['need', `write/aws-role/${ACCOUNT}/deploy`, ...WHY, '--plan', 'put a parameter (undo: delete it)', '--command', 'true', '--wait', '60']);
    await run.waiting;
    const [card] = (await vaultOf(b)).runs ?? [];
    const approved = await b.a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve-run', job: jobId, template: card!.template, allowAgain: true }, { token: b.token });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await run.end).stderr).toContain('hopper-step: the template is ready; the step runs now');
    const t = approved.body.templates.find((x) => x.name === card!.template)!;
    expect(t.approval).toMatchObject({ by: expect.any(String) });
    expect(t.approval!.jobs).toBeUndefined();
    expect(approved.body.rememberedWrites).toEqual([expect.objectContaining({ operation: 'write', asset: { kind: 'aws-role', name: `${ACCOUNT}/deploy` } })]);
  });

  it('a declined run card tells the waiting step no (issue #2197)', async () => {
    const b = await bootSteps([]);
    const { creds, jobId } = await stepJob(b);
    const write = `write/aws-role/${ACCOUNT}/deploy`;
    const run = step(b, creds, ['need', write, ...WHY, '--plan', 'put a parameter (undo: delete it)', '--command', 'true', '--wait', '60']);
    await run.waiting;
    const [card] = (await vaultOf(b)).runs ?? [];
    expect(card).toMatchObject({ jobId, waits: { template: true, run: false } });
    const declined = await b.a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'decline-run', job: jobId, template: card!.template, reason: 'not tonight' }, { token: b.token });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.runs).toEqual([]);
    const r = await run.end;
    // A person's decline is a deny at gate 2 (issue #655 part 5): the job's trust one level lower, so its step is told no.
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('no: ');
    expect(stepBoxes(b)).toHaveLength(0);
    expect((await ofJob(b, jobId)).find((e) => e.type === 'vault.sandbox_declined')?.data).toMatchObject({ template: card!.template, reason: 'not tonight' });
  });

  it('a need the vault mints nothing for is refused, saying why; a bad call is refused before anything runs', async () => {
    const b = await bootSteps(['aws-account/*']);
    const { creds } = await stepJob(b);
    const account = await step(b, creds, ['need', `read/aws-account/${ACCOUNT}`, ...WHY, '--command', 'aws sts get-caller-identity', '--wait', '5']).end;
    expect(account.code).toBe(125);
    expect(account.stderr).toContain(`no: read/aws-account/${ACCOUNT}: the hopper mints a credential for a step for an aws-role, a cluster or a namespace only`);
    // Refused before any template is made.
    expect((await templates(b)).filter((x) => x.name.startsWith('asked-'))).toHaveLength(0);

    const bad = await step(b, creds, ['need', 'read/nothing', ...WHY, '--command', 'true']).end;
    expect(bad.code).toBe(125);
    expect(bad.stderr).toContain('no: ');
    const secret = await step(b, creds, ['need', READ, '--secret', 'X', '--command', 'true']).end;
    expect(secret.code).toBe(2);
    expect(secret.stderr).toContain('never a vault secret by name');
    await waitFor(() => b.runtime.boxes.size === 0, { what: 'no box left' });
    expect(stepBoxes(b)).toHaveLength(0);
  });
});
