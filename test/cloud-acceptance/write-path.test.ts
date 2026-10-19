// Issue #1956 (acceptance criterion 4, the write path): only the saved plan the hopper recorded applies, against moto
// behind the policy-assert proxy. A box of a write template plans with its read session, the job records the plan with
// its saved file (issue #870), a person approves it, and the vault mints the apply session only for that plan at the
// commit its branch is at now. In the box, terraform runs behind the apply wrapper (src/sandbox/terraform-wrapper.ts),
// which fetches the plan's saved file from the hopper with the job's proxy token and applies that file alone. Not part of
// `npm test`: `npm run test:cloud` (vitest.cloud.config.ts).
//
// Feature: only the recorded, approved, current saved plan applies
//   Scenario: the recorded plan applies once; a tampered or stale plan is refused
//     Given a job at work on a box of infra-write, whose template reads and applies on the seed's write role
//     And GitHub says octo/infra issue-1 is at commit A
//     When the box plans a workspace that makes an S3 bucket, with its read session, and the job records the plan
//     Then the plan is kept with its saved file, its summary not failed
//     When the job asks for the apply session before a person approved the plan
//     Then it is refused, and STS is asked for no session
//     When a person approves it, and the branch moved to commit B
//     Then the ask is refused: the code moved since the plan, and STS is asked for no session
//     When the branch is at A again
//     Then the vault mints the apply session
//     When the box applies a tampered copy of the saved file, or applies with no plan named
//     Then the apply wrapper refuses it, and no call of the apply session reaches the proxy
//     When the box applies the plan the hopper recorded
//     Then the wrapper fetches its saved file, terraform applies it, and moto holds the bucket: one CreateBucket made it
//     When the box applies the same plan again
//     Then terraform refuses the stale plan, and moto is the same as after the first apply
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
import { MAP_TAG } from '../../src/domain/infra-plan-changes.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { APPLY_WRAPPER_REFUSAL } from '../../src/sandbox/terraform-wrapper.ts';
import type { TestApp } from '../support/app.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { helper, runningJob } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';
import { startBox, writeBoxImage, type Box } from './support/box.ts';
import { cloudHopper } from './support/hopper.ts';
import { ACCOUNT, REGION, SEED_KEYS, startMoto, stateHash, type Moto } from './support/moto.ts';

const TEMPLATE = 'infra-write';
const BOX = `hopper-sandbox-${TEMPLATE}`;
const ROLE = `aws-role/${ACCOUNT}/write`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PLANTED = 'planted-by-plan';

let moto: Moto;
let image: { image: string; user: string };
let box: Box | undefined;
let github: FakeForge | undefined;
const h = cloudHopper();

beforeAll(async () => {
  moto = await startMoto();
  image = await writeBoxImage();
}, 1_200_000);
afterAll(async () => { await moto?.stop(); });
afterEach(async () => {
  await box?.end();
  box = undefined;
  await h.end();
  await github?.close();
  github = undefined;
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

/** The hopper with GitHub faked (the plan's branch at A), and the template infra-write approved: read and apply on the write role. */
async function boot() {
  github = await createFakeGitHub({ clientId: 'gh-client-id' });
  github.tokens.set('test-account-token', 'owner');
  github.heads = { 'octo/infra@issue-1': A };
  const booted = await h.boot(moto.url, { env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' } });
  const { a, session } = booted;
  connectGitHub(a, ['octo/infra'], { key: KEY });
  // An apply profile rates the box high (issue #605); the blast-radius gate is not under test here.
  expect((await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session })).status).toBe(200);
  const edit = async (body: Record<string, unknown>) => expect((await a.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
  const asset = { kind: 'aws-role', name: `${ACCOUNT}/write` };
  const profiles = [{ operation: 'read', asset }, { operation: 'apply', asset }];
  await edit({ action: 'save-template', name: TEMPLATE, image: 'localhost/box-terraform:1', secrets: [], profiles });
  await edit({ action: 'approve-template', name: TEMPLATE });
  for (const p of profiles) await edit({ action: 'approve-profile', name: TEMPLATE, ...p });
  const dir = await h.box.join(a, session, BOX, TEMPLATE);
  const job = await runningJob(a, BOX);
  return { ...booted, dir, job, token: h.box.tokenFileOf(a, job), github };
}

const tokenOf = (a: TestApp, job: string): string => proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);

/** The buckets moto holds, read with the seed's key through the proxy. */
async function buckets(url: string): Promise<string[]> {
  const s3 = new S3Client({ endpoint: url, region: REGION, forcePathStyle: true, maxAttempts: 1, credentials: SEED_KEYS });
  try {
    return ((await s3.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name!).sort();
  } finally {
    s3.destroy();
  }
}

/** A session's keys, as the box's AWS environment. */
const awsEnv = (k: { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string }): Record<string, string> =>
  ({ AWS_ACCESS_KEY_ID: k.AccessKeyId, AWS_SECRET_ACCESS_KEY: k.SecretAccessKey, ...(k.SessionToken ? { AWS_SESSION_TOKEN: k.SessionToken } : {}) });

describe('the write path against a mock AWS behind the policy-assert proxy (issue #1956)', () => {
  it('applies only the recorded, approved, current saved plan, once; a tampered or stale plan is refused', async () => {
    const { a, session, proxy, dir, job, token } = await boot();
    const read = await helper(dir, ['aws', 'read', ROLE], token);
    expect(read.code, read.stderr).toBe(0);
    const readKeys = JSON.parse(read.stdout) as { AccessKeyId: string; SecretAccessKey: string; SessionToken: string };
    box = await startBox(image, readKeys);

    // The box plans with its read session, as a job does.
    expect((await box.exec(['sh', '-c', 'printf "%s" "$TF_MAIN" > main.tf'], { env: { TF_MAIN: workspace(proxy.url) } })).code).toBe(0);
    const init = await box.exec(['terraform', 'init', '-input=false', '-no-color']);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const planned = await box.exec(['terraform', 'plan', '-input=false', '-no-color', '-out=plan.tfplan']);
    expect(planned.code, planned.stdout + planned.stderr).toBe(0);
    expect(planned.stdout).toMatch(/Plan: 1 to add, 0 to change, 0 to destroy/);
    const text = (await box.exec(['terraform', 'show', '-no-color', 'plan.tfplan'])).stdout;
    const json = (await box.exec(['terraform', 'show', '-json', 'plan.tfplan'])).stdout;
    const file = (await box.exec(['base64', '-w0', 'plan.tfplan'])).stdout;

    // The job records it with its saved file: the route the apply wrapper fetches the file from.
    const recorded = await fetch(`${a.url}/job/infra-plans`, {
      method: 'POST', headers: { authorization: `Bearer ${tokenOf(a, job)}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'terraform', asset: ROLE, target: 'acceptance', repo: 'octo/infra', ref: 'issue-1', commit: A, pullRequest: 1, read: `read/${ROLE}`, text, json, file }),
    });
    const body = (await recorded.json()) as { plan: InfraPlan; error?: string };
    expect(recorded.status, body.error).toBe(201);
    const plan = body.plan;
    expect(plan.file?.size).toBe(Buffer.from(file, 'base64').length);
    expect(plan.summary?.failed).toBe(false);

    const sessions = () => [...proxy.sessions.keys()];
    const minted = sessions();
    expect(minted).toEqual([readKeys.AccessKeyId]);
    const applyAsk = () => helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);

    // Not approved yet: nothing minted.
    const unapproved = await applyAsk();
    expect(unapproved.code).not.toBe(0);
    expect(unapproved.stderr).toMatch(/is not approved/);
    expect(sessions()).toEqual(minted);

    expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id }, { token: session })).status).toBe(200);

    // Stale: the branch moved since the plan. Nothing minted.
    github!.heads = { 'octo/infra@issue-1': B };
    const moved = await applyAsk();
    expect(moved.code).not.toBe(0);
    expect(moved.stderr).toMatch(/the code moved since plan .*Plan again/);
    expect(sessions()).toEqual(minted);

    github!.heads = { 'octo/infra@issue-1': A };
    const apply = await applyAsk();
    expect(apply.code, apply.stderr).toBe(0);
    const applyKeys = JSON.parse(apply.stdout) as { AccessKeyId: string; SecretAccessKey: string; SessionToken: string };
    expect(sessions()).toEqual([...minted, applyKeys.AccessKeyId]);

    // The job's way to the hopper in the box: its URL and its proxy token in a file.
    const tokenFile = (await box.exec(['sh', '-c', 'f="$HOME/hopper-token"; printf "%s\\n" "$T" > "$f"; chmod 600 "$f"; printf "%s" "$f"'], { env: { T: tokenOf(a, job) } })).stdout;
    const env = { ...awsEnv(applyKeys), HOPPER_URL: a.url, HOPPER_TOKEN_FILE: tokenFile, HOPPER_PLAN: plan.id };
    const reached = proxy.log.length;
    const ofApply = () => proxy.log.slice(reached).filter((d) => d.accessKeyId === applyKeys.AccessKeyId);
    const before = await stateHash(proxy.url);

    // Tampered: a copy of the saved file with one byte more is not the recorded plan.
    expect((await box.exec(['sh', '-c', 'cp plan.tfplan tampered.tfplan && printf x >> tampered.tfplan'])).code).toBe(0);
    const tampered = await box.exec(['terraform', 'apply', '-auto-approve', '-input=false', '-no-color', 'tampered.tfplan'], { env });
    expect(tampered.code).not.toBe(0);
    expect(tampered.stderr).toContain(APPLY_WRAPPER_REFUSAL);
    expect(tampered.stderr).toMatch(/tampered\.tfplan is not the saved plan file of plan/);
    // No plan named: refused too.
    const { HOPPER_PLAN: _plan, ...noPlan } = env;
    const unnamed = await box.exec(['terraform', 'apply', '-auto-approve', '-input=false', '-no-color'], { env: noPlan });
    expect(unnamed.code).not.toBe(0);
    expect(unnamed.stderr).toMatch(/refused by the apply wrapper\. There is no apply without a plan/);
    expect(ofApply()).toEqual([]);
    expect(await stateHash(proxy.url)).toBe(before);

    // The recorded plan: the wrapper fetches its saved file and terraform applies it.
    const applied = await box.exec(['terraform', 'apply', '-auto-approve', '-input=false', '-no-color'], { env });
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toMatch(/Apply complete! Resources: 1 added, 0 changed, 0 destroyed/);
    expect(await buckets(proxy.url)).toContain(PLANTED);
    // The provider may send CreateBucket again in another form when moto refuses its first (tags in the create): moto made one bucket.
    const creates = () => ofApply().filter((d) => d.action === 's3:CreateBucket' && d.status === 200);
    expect(creates(), JSON.stringify(ofApply().map((d) => `${d.method} ${d.action} ${d.status}`))).toEqual([expect.objectContaining({ allowed: true, resource: `arn:aws:s3:::${PLANTED}` })]);
    expect(ofApply().filter((d) => !d.allowed), JSON.stringify(ofApply())).toEqual([]);
    const after = await stateHash(proxy.url);
    expect(after).not.toBe(before);

    // The same plan again: its state moved on, so terraform refuses the stale plan and nothing more is made.
    const again = await box.exec(['terraform', 'apply', '-auto-approve', '-input=false', '-no-color'], { env });
    expect(again.code).not.toBe(0);
    expect(`${again.stdout}${again.stderr}`).toMatch(/Saved plan is stale/);
    expect(creates()).toHaveLength(1);
    expect(await stateHash(proxy.url)).toBe(after);
  }, 900_000);
});
