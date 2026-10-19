// Issue #1956 (acceptance criterion 2, the terraform route): terraform in a read-only template's box, with the box's read
// session, against moto behind the policy-assert proxy. The box image is the one the hopper makes for that template
// (support/box.ts): the published box image with terraform and the aws CLI, terraform behind the read-only wrapper, its
// providers from the image's mirror. Not part of `npm test`: `npm run test:cloud` (vitest.cloud.config.ts).
//
// Feature: terraform in a read-only box cannot write, through the wrapper or past it
//   Scenario: the wrapper refuses apply, and the account refuses the real binary
//     Given a job's read session on a box of the read-only image, and a workspace that makes an S3 bucket
//     When terraform runs init and plan
//     Then both work, and the plan adds the bucket
//     When it runs apply, and apply -auto-approve
//     Then the read-only wrapper refuses each, and no call reaches the proxy
//     When the real binary runs apply -auto-approve by its absolute path
//     Then the proxy denies its CreateBucket, and terraform fails
//     When the box's aws CLI deletes the state object
//     Then the proxy denies it
//     And moto's state hash is the same before and after, and the proxy allowed no write of the session
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WRAPPER_REFUSAL } from '../../src/sandbox/terraform-wrapper.ts';
import { readOnlyBoxImage, REAL_TERRAFORM, startBox, type Box } from './support/box.ts';
import { cloudHopper } from './support/hopper.ts';
import { BUCKET, REGION, startMoto, stateHash, STATE_KEY, type Moto } from './support/moto.ts';

let moto: Moto;
let image: { image: string; user: string };
let box: Box | undefined;
const h = cloudHopper();

beforeAll(async () => {
  moto = await startMoto();
  image = await readOnlyBoxImage();
}, 1_200_000);
afterAll(async () => { await moto?.stop(); });
afterEach(async () => {
  await box?.end();
  box = undefined;
  await h.end();
});

/** A workspace that makes one bucket, every AWS endpoint the proxy. */
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
  endpoints {
    s3  = "${endpoint}"
    sts = "${endpoint}"
    iam = "${endpoint}"
    ec2 = "${endpoint}"
  }
}
resource "aws_s3_bucket" "planted" {
  bucket = "planted-by-terraform"
}
`;

describe('terraform in a read-only box against a mock AWS behind the policy-assert proxy (issue #1956)', () => {
  it('the wrapper refuses apply before any call; the real binary, by its absolute path, is denied at the proxy; moto is unchanged', async () => {
    const { a, session, proxy } = await h.boot(moto.url);
    const { keys } = await h.readSession(a, session);
    box = await startBox(image, keys);
    const wrote = await box.exec(['sh', '-c', 'printf "%s" "$TF_MAIN" > main.tf'], { env: { TF_MAIN: workspace(proxy.url) } });
    expect(wrote.code, wrote.stderr).toBe(0);

    const init = await box.exec(['terraform', 'init', '-input=false', '-no-color']);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const plan = await box.exec(['terraform', 'plan', '-input=false', '-no-color']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    expect(plan.stdout).toMatch(/Plan: 1 to add, 0 to change, 0 to destroy/);

    const before = await stateHash(proxy.url);
    const reached = proxy.log.length;
    const ofSession = () => proxy.log.slice(reached).filter((d) => d.accessKeyId === keys.AccessKeyId);

    // Through the wrapper, first on PATH: refused before the real binary runs, so nothing reaches the account.
    for (const args of [['apply', '-input=false'], ['apply', '-auto-approve', '-input=false']]) {
      const r = await box.exec(['terraform', ...args]);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toContain(WRAPPER_REFUSAL);
    }
    expect(ofSession()).toEqual([]);

    // Past the wrapper: the real binary applies, and the read session's policy refuses the write at the proxy.
    const past = await box.exec([REAL_TERRAFORM, 'apply', '-auto-approve', '-input=false', '-no-color']);
    expect(past.code, past.stdout).not.toBe(0);
    expect(`${past.stdout}${past.stderr}`).toMatch(/AccessDenied|403/);
    expect(ofSession().filter((d) => d.action === 's3:CreateBucket' && !d.allowed).length).toBeGreaterThanOrEqual(1);

    // The box's aws CLI is refused too.
    const rm = await box.exec(['aws', '--endpoint-url', proxy.url, 's3api', 'delete-object', '--bucket', BUCKET, '--key', STATE_KEY]);
    expect(rm.code).not.toBe(0);
    expect(`${rm.stdout}${rm.stderr}`).toMatch(/AccessDenied/);

    expect(await stateHash(proxy.url)).toBe(before);
    const allowed = ofSession().filter((d) => d.allowed && !/^(s3:(Get|List|Head)|sts:GetCallerIdentity)/.test(d.action ?? ''));
    expect(allowed, JSON.stringify(allowed)).toEqual([]);
    expect(ofSession().some((d) => d.action === 's3:DeleteObject' && !d.allowed)).toBe(true);
  }, 600_000);
});
