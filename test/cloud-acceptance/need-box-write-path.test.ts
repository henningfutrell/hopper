// Issue #1956 (acceptance criterion 4, inside a need box): the write path as a job takes it with need steps, against moto
// behind the policy-assert proxy. The hopper is the crash harness's (test/crash/harness.ts): the real composition root in
// a process of its own, its need boxes on the real container runtime (Podman's or Docker's socket), under the sandbox
// flags, from the image the hopper makes for the template (the write box image: terraform behind the apply wrapper).
// A first need step plans with a read session and brings the saved plan file back as an output; the job records the plan
// with that file (issue #870), and a person approves it. A need step that applies names the plan (`planId`): the vault
// mints its apply session only through the apply gate, and the hopper puts the plan's saved file in the box
// (HOPPER_PLAN_FILE), which holds no proxy token. Not part of `npm test`: `npm run test:cloud`.
//
// Feature: in a need box, only the recorded, approved, current saved plan applies
//   Scenario: the recorded plan applies once; every other apply is refused
//     Given a job at work whose template reads and applies on the seed's write role, and GitHub says octo/infra issue-1 is at commit A
//     When a need step plans a workspace that makes an S3 bucket, with its read session, and the job records the plan with its saved file
//     Then the plan is kept with its saved file, its summary not failed
//     When an apply step names no plan, or names the plan before a person approved it
//     Then the step ends refused, and STS is asked for no apply session
//     When a person approves the plan, and the branch moved to commit B
//     Then the apply step ends refused: the code moved since the plan, and STS is asked for no apply session
//     When infra applies are off on the hopper
//     Then the apply step is refused when asked
//     When the branch is at A again, and the apply step applies a tampered copy of the saved file
//     Then the apply wrapper refuses it, and no call of the apply session reaches the proxy
//     When the apply step applies the plan the hopper put in the box
//     Then terraform applies it, and moto holds the bucket: one CreateBucket made it
//     When the same plan is applied again
//     Then terraform refuses the stale plan, and moto is the same as after the first apply
//     And no need box and no home volume is left at the runtime
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { MAP_TAG } from '../../src/domain/infra-plan-changes.ts';
import { APPLY_STEP_OFF, type InfraPlan } from '../../src/domain/infra-plans.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { APPLY_WRAPPER_REFUSAL } from '../../src/sandbox/terraform-wrapper.ts';
import { openDb } from '../../src/store/db.ts';
import { STEP_HEADER, STEP_PATH } from '../../src/windows-steps/script.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { startPolicyAssertProxy, type PolicyAssertProxy } from '../support/policy-assert-proxy.ts';
import { waitFor } from '../support/wait.ts';
import { startHost, stopHosts, type CrashHost } from '../crash/harness.ts';
import { BOX_BASE, cli, runtimeSocket, writeBoxImage } from './support/box.ts';
import { MINTING, SESSION_NAME } from './support/hopper.ts';
import { ACCOUNT, REGION, resetMoto, seed, SEED_KEYS, startMoto, stateHash, WRITE_ROLE, type Moto } from './support/moto.ts';

const REPO = 'octo/infra';
const REF = 'issue-1';
const TEMPLATE = 'infra-apply-step';
const ASSET = `aws-role/${ACCOUNT}/write`;
const READ = `read/${ASSET}`;
const APPLY = `apply/${ASSET}`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PLANTED = 'planted-by-need-step';
/** The most a step takes: terraform init fetches the AWS provider from the registry. */
const STEP_MS = 300_000;

let moto: Moto;
let dir: string;
let world: { proxy: PolicyAssertProxy; github: FakeForge; url: string; cleanup(): void } | undefined;

beforeAll(async () => {
  moto = await startMoto();
  // The image the hopper makes for the template, built once: a hopper builds it again only when it is missing.
  await writeBoxImage();
}, 1_200_000);
afterAll(async () => { await moto?.stop(); });
afterEach(async () => {
  await stopHosts();
  if (world) for (const id of await leftAtRuntime(world.url)) await cli(['rm', '-f', '-t', '0', id]).then((r) => (r.code === 0 ? r : cli(['volume', 'rm', '-f', id])));
  await world?.proxy.close();
  await world?.github.close();
  world?.cleanup();
  world = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A workspace that makes one bucket, tagged as the plan check asks (the MAP tag), every AWS endpoint the proxy. */
const workspace = (endpoint: string): string => `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.68.0" }
  }
}
provider "aws" {
  region                      = "${REGION}"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  default_tags {
    tags = { "${MAP_TAG.key}" = "${MAP_TAG.value}" }
  }
  endpoints {
    s3  = "${endpoint}"
    sts = "${endpoint}"
    iam = "${endpoint}"
    ec2 = "${endpoint}"
  }
}
resource "aws_s3_bucket" "planted" {
  bucket = "${PLANTED}"
}
`;

/** The instance id the hopper on the database at `url` has: its need boxes carry it. */
function instanceOf(url: string): string | undefined {
  const db = openDb(url);
  try { return (db.get('SELECT value FROM settings WHERE key = ?', 'instanceId') as { value: string } | undefined)?.value; } finally { db.close(); }
}

/** The need boxes and their home volumes of the hopper on the database at `url` that the runtime still holds. */
async function leftAtRuntime(url: string): Promise<string[]> {
  const instance = instanceOf(url);
  if (!instance) return [];
  const label = `label=${NEED_LABEL}=${instance}`;
  const boxes = (await cli(['ps', '-a', '-q', '--filter', label])).stdout.split('\n').filter(Boolean);
  const homes = (await cli(['volume', 'ls', '-q', '--filter', label])).stdout.split('\n').filter(Boolean);
  return [...boxes, ...homes];
}

/** The files of `from` named, as a tar: a step's inputs. */
function tarOf(from: string, files: string[]): Buffer {
  return execFileSync('tar', ['-cf', '-', '-C', from, ...files]);
}

interface Ended { exit: number; problem: string | undefined; log: string; outputs: Buffer }

/** A job's request on `/job/step` as `hopper-step` sends it, with its inputs as the body. */
async function asJob(h: CrashHost, method: string, path: string, body?: Buffer): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    method, headers: { authorization: `Bearer ${h.job!.proxyToken}`, ...(body ? { 'content-type': 'application/x-tar' } : {}) },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

/** A need step asked and read to its end: its exit code, the hopper's problem, its log and its outputs. */
async function step(h: CrashHost, q: { needs: string; key: string; command: string; planId?: string; output?: string[] }, inputs: Buffer): Promise<Ended> {
  const params = new URLSearchParams({ needs: q.needs, key: q.key, command: q.command, timeout: String(STEP_MS / 1000) });
  if (q.planId) params.set('planId', q.planId);
  for (const o of q.output ?? []) params.append('output', o);
  const asked = await asJob(h, 'POST', `${STEP_PATH}?${params.toString()}`, inputs);
  const text = await asked.text();
  expect(asked.status, text).toBe(202);
  const id = asked.headers.get(STEP_HEADER.id)!;
  const result = await waitFor(async () => {
    const r = await asJob(h, 'GET', `${STEP_PATH}/${id}`);
    return r.status === 202 ? (await r.arrayBuffer(), undefined) : r;
  }, { timeoutMs: STEP_MS, intervalMs: 500, what: `step ${q.key} to end` });
  expect(result.status).toBe(200);
  const outputs = Buffer.from(await result.arrayBuffer());
  const log = await (await asJob(h, 'GET', `${STEP_PATH}/${id}/log?from=0`)).text();
  return { exit: Number(result.headers.get(STEP_HEADER.exit)), problem: result.headers.get(STEP_HEADER.problem) ?? undefined, log, outputs };
}

/** The buckets moto holds, read with the seed's key through the proxy. */
async function buckets(url: string): Promise<string[]> {
  const s3 = new S3Client({ endpoint: url, region: REGION, forcePathStyle: true, maxAttempts: 1, credentials: SEED_KEYS });
  try {
    return ((await s3.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name!).sort();
  } finally {
    s3.destroy();
  }
}

/** moto reset and seeded behind a new proxy, the fake GitHub (the plan's branch at A, the job's issue), and a hopper with the job at work. */
async function setUp(): Promise<{ h: CrashHost; proxy: PolicyAssertProxy; github: FakeForge }> {
  await resetMoto(moto.url);
  const proxy = await startPolicyAssertProxy({ upstream: moto.url, admins: [SEED_KEYS.accessKeyId, MINTING.AccessKeyId] });
  await seed(proxy.url);
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Make the bucket', body: 'Please.', author: 'owner', labels: [] });
  github.heads = { [`${REPO}@${REF}`]: A };
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  world = { proxy, github, url, cleanup: db.cleanup };
  const h = await startHost({ dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, ...runtimeSocket(), connectGitHub: [REPO], job: `${REPO}#7` });
  const ui = async (path: string, body: Record<string, unknown>) => { const r = await h.ui(path, body); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  await ui('/ui/api/vault', { action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ ...MINTING, Region: REGION, Endpoint: proxy.url, SessionName: SESSION_NAME }) });
  // An apply profile rates the template high (issue #605); the blast-radius gate is not under test here.
  await ui('/ui/api/blast-radius/settings', { gateAt: 'off' });
  const asset = { kind: 'aws-role', name: `${ACCOUNT}/write` };
  const profiles = [{ operation: 'read', asset }, { operation: 'apply', asset }];
  await ui('/ui/api/vault', { action: 'save-template', name: TEMPLATE, image: BOX_BASE, tools: ['terraform', 'aws'], secrets: [], profiles });
  await ui('/ui/api/vault', { action: 'approve-template', name: TEMPLATE });
  for (const p of profiles) await ui('/ui/api/vault', { action: 'approve-profile', name: TEMPLATE, ...p });
  return { h, proxy, github };
}

describe('the write path in need boxes against a mock AWS behind the policy-assert proxy (issue #1956, criterion 4)', () => {
  it('applies only the recorded, approved, current saved plan the hopper puts in the box, once; every other apply is refused', async () => {
    const { h, proxy, github } = await setUp();
    dir = mkdtempSync(join(tmpdir(), 'hopper-acceptance-need-write-'));
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'main.tf'), workspace(proxy.url));
    const writeSessions = () => [...proxy.sessions.values()].filter((s) => s.roleArn === WRITE_ROLE).map((s) => s.accessKeyId);

    // The plan: a need step with the read session, its saved file and its shows brought back as outputs.
    const planned = await step(h, {
      needs: READ, key: 'acceptance-plan-0001', output: ['plan.tfplan', 'plan.txt', 'plan.json', '.terraform.lock.hcl'],
      command: 'terraform init -input=false -no-color && terraform plan -input=false -no-color -out=plan.tfplan && terraform show -no-color plan.tfplan > plan.txt && terraform show -json plan.tfplan > plan.json',
    }, tarOf(work, ['main.tf']));
    expect({ exit: planned.exit, problem: planned.problem }, planned.log).toEqual({ exit: 0, problem: undefined });
    expect(planned.log).toMatch(/Plan: 1 to add, 0 to change, 0 to destroy/);
    execFileSync('tar', ['-xf', '-', '-C', work], { input: planned.outputs });
    const file = readFileSync(join(work, 'plan.tfplan'));
    const readSession = writeSessions();
    expect(readSession).toHaveLength(1);

    // The job records it with its saved file.
    const recorded = await fetch(`${h.url}/job/infra-plans`, {
      method: 'POST', headers: { authorization: `Bearer ${h.job!.proxyToken}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'terraform', asset: ASSET, target: 'acceptance', repo: REPO, ref: REF, commit: A, pullRequest: 1, read: READ, text: readFileSync(join(work, 'plan.txt'), 'utf8'), json: readFileSync(join(work, 'plan.json'), 'utf8'), file: file.toString('base64') }),
    });
    const body = (await recorded.json()) as { plan: InfraPlan; error?: string };
    expect(recorded.status, body.error).toBe(201);
    const plan = body.plan;
    expect(plan.file?.size).toBe(file.length);
    expect(plan.summary?.failed).toBe(false);

    const applyCommand = (named = '') => `terraform init -input=false -no-color >/dev/null && terraform apply -auto-approve -input=false -no-color ${named}`;
    const inputs = tarOf(work, ['main.tf', '.terraform.lock.hcl']);
    let keys = 0;
    const apply = (o: { planId?: string; command?: string; inputs?: Buffer; output?: string[] } = {}) =>
      step(h, { needs: APPLY, key: `acceptance-apply-${String(++keys).padStart(4, '0')}`, command: o.command ?? applyCommand(), ...(o.planId ? { planId: o.planId } : {}), ...(o.output ? { output: o.output } : {}) }, o.inputs ?? inputs);
    const before = await stateHash(proxy.url);

    // No plan named, and the plan not approved yet: the gate refuses the mint; no apply session.
    const unnamed = await apply();
    expect({ exit: unnamed.exit, problem: unnamed.problem }).toEqual({ exit: 125, problem: expect.stringMatching(/no apply without a plan/) });
    const unapproved = await apply({ planId: plan.id });
    expect({ exit: unapproved.exit, problem: unapproved.problem }).toEqual({ exit: 125, problem: expect.stringMatching(/is not approved/) });
    expect(writeSessions()).toEqual(readSession);

    const approved = await h.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    // Stale: the branch moved since the plan. No apply session.
    github.heads = { [`${REPO}@${REF}`]: B };
    const moved = await apply({ planId: plan.id });
    expect({ exit: moved.exit, problem: moved.problem }).toEqual({ exit: 125, problem: expect.stringMatching(/the code moved since plan .*Plan again/) });
    expect(writeSessions()).toEqual(readSession);
    github.heads = { [`${REPO}@${REF}`]: A };

    // Infra applies off on the hopper: the step is refused when asked.
    expect((await h.ui('/ui/api/infra-applies', { on: false })).status).toBe(200);
    const off = await asJob(h, 'POST', `${STEP_PATH}?${new URLSearchParams({ needs: APPLY, key: 'acceptance-apply-off', command: applyCommand(), planId: plan.id }).toString()}`, inputs);
    expect(off.status).toBe(409);
    expect(await off.text()).toContain(APPLY_STEP_OFF);
    expect((await h.ui('/ui/api/infra-applies', { on: true })).status).toBe(200);
    expect(writeSessions()).toEqual(readSession);
    expect(await stateHash(proxy.url)).toBe(before);

    // Tampered: a copy of the saved file with one byte more is not the plan the hopper put in the box.
    copyFileSync(join(work, 'plan.tfplan'), join(work, 'tampered.tfplan'));
    appendFileSync(join(work, 'tampered.tfplan'), 'x');
    const reachedTampered = proxy.log.length;
    const tampered = await apply({ planId: plan.id, command: applyCommand('tampered.tfplan'), inputs: tarOf(work, ['main.tf', '.terraform.lock.hcl', 'tampered.tfplan']) });
    expect(tampered.exit, tampered.log).not.toBe(0);
    expect(tampered.problem).toBeUndefined();
    expect(tampered.log).toContain(APPLY_WRAPPER_REFUSAL);
    expect(tampered.log).toMatch(/tampered\.tfplan is not the saved plan file of plan/);
    const tamperedSession = writeSessions().filter((k) => !readSession.includes(k));
    expect(tamperedSession).toHaveLength(1);
    expect(proxy.log.slice(reachedTampered).filter((d) => d.accessKeyId === tamperedSession[0])).toEqual([]);
    expect(await stateHash(proxy.url)).toBe(before);

    // The recorded plan: the wrapper applies the saved file the hopper put in the box.
    const reached = proxy.log.length;
    const applied = await apply({ planId: plan.id, output: ['terraform.tfstate'] });
    expect({ exit: applied.exit, problem: applied.problem }, applied.log).toEqual({ exit: 0, problem: undefined });
    expect(applied.log).toMatch(/Apply complete! Resources: 1 added, 0 changed, 0 destroyed/);
    expect(await buckets(proxy.url)).toContain(PLANTED);
    const applySessions = writeSessions().filter((k) => !readSession.includes(k) && !tamperedSession.includes(k));
    expect(applySessions).toHaveLength(1);
    const ofApply = () => proxy.log.slice(reached).filter((d) => d.accessKeyId !== undefined && !readSession.includes(d.accessKeyId) && !tamperedSession.includes(d.accessKeyId));
    // The provider may send CreateBucket again in another form when moto refuses its first (tags in the create): moto made one bucket.
    const creates = () => ofApply().filter((d) => d.action === 's3:CreateBucket' && d.status === 200);
    expect(creates(), JSON.stringify(ofApply().map((d) => `${d.method} ${d.action} ${d.status}`))).toEqual([expect.objectContaining({ allowed: true, resource: `arn:aws:s3:::${PLANTED}` })]);
    expect(ofApply().filter((d) => !d.allowed), JSON.stringify(ofApply())).toEqual([]);
    const after = await stateHash(proxy.url);
    expect(after).not.toBe(before);

    // The same plan again, on the state the apply left (the box keeps none: it comes back as an output): the state moved
    // on, so terraform refuses the stale plan and nothing more is made.
    execFileSync('tar', ['-xf', '-', '-C', work], { input: applied.outputs });
    const again = await apply({ planId: plan.id, inputs: tarOf(work, ['main.tf', '.terraform.lock.hcl', 'terraform.tfstate']) });
    expect(again.exit, again.log).not.toBe(0);
    expect(again.log).toMatch(/Saved plan is stale/);
    expect(creates()).toHaveLength(1);
    expect(await stateHash(proxy.url)).toBe(after);

    // Each need box and its home volume are burned after its step.
    await waitFor(async () => ((await leftAtRuntime(world!.url)).length === 0 ? true : undefined), { timeoutMs: 60_000, intervalMs: 500, what: 'no need box or home left at the runtime' });
  }, 1_800_000);
});
