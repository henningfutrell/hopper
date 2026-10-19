// Issue #1956 (acceptance criterion 2, inside a need box): a read-only template's need box, run by the hopper's sandbox
// module (`createSandboxes`, its real flags) through the real container runtime, behind the real egress proxy, with a
// read session the vault minted. Its credential names the policy-assert proxy in front of moto as its endpoint, so the
// egress proxy allows that host and the box reaches moto only through both proxies. The step's command writes by every
// route a job has: the aws CLI, terraform through the read-only wrapper and past it, curl's own SigV4, and a script on
// the AWS SDK (box-sdk.ts, bundled into the step's inputs). Not part of `npm test`: `npm run test:cloud`.
//
// Feature: a read-only need box cannot write by any route, under the sandbox flags and behind the egress proxy
//   Scenario: every write is denied at the policy-assert proxy, and moto is unchanged
//     Given a read session the vault minted for the seed's read role, and a need box of the read-only image behind the egress proxy
//     When the box's aws CLI reads the state object
//     Then the read goes through both proxies
//     When the aws CLI deletes the state object and terminates the instance
//     And terraform applies through the wrapper, and the real binary applies -auto-approve by its absolute path
//     And curl PUTs an object with its own SigV4 signature, and the SDK script puts and deletes objects
//     Then the wrapper refuses before any call, and the proxy denies each write that reaches it
//     And moto's state hash is the same before and after, and the proxy allowed no write of the session
//     And after the step no box and no home volume of it remain
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { createEgress } from '../../src/sandbox/egress.ts';
import { NEED_LABEL, needEnv, type NeedCredential } from '../../src/sandbox/need-box.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { WRAPPER_REFUSAL } from '../../src/sandbox/terraform-wrapper.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';
import { BOX_BASE, cli, readOnlyBoxImage, REAL_TERRAFORM, runtime, SDK_SCRIPT, sdkScriptInputs } from './support/box.ts';
import { startEgressStack, type EgressStack } from './support/egress.ts';
import { cloudHopper } from './support/hopper.ts';
import { ACCOUNT, BUCKET, REGION, startMoto, stateHash, STATE_KEY, type Moto } from './support/moto.ts';

const INSTANCE = `acceptance-need-read-${process.pid}`;
/** The name the egress proxy resolves to this machine, where the policy-assert proxy listens. */
const HOST_ALIAS = 'hopper-acceptance-host';

let moto: Moto;
let stack: EgressStack;
let dir: string;
let inputs: string;
const h = cloudHopper();

beforeAll(async () => {
  moto = await startMoto();
  await readOnlyBoxImage();
  stack = await startEgressStack({ hostAlias: HOST_ALIAS });
  dir = mkdtempSync(join(tmpdir(), 'hopper-acceptance-need-read-'));
  inputs = await sdkScriptInputs(dir);
}, 1_200_000);
afterAll(async () => {
  await stack?.end();
  await moto?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => { await h.end(); });

const repo = (): Pick<SandboxRepository, 'list' | 'remove'> => ({ list: () => [], remove: () => false });

/** A workspace that makes one bucket, every AWS endpoint `endpoint`. */
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

/** One route of the command: its output between two marks, then its exit code. */
const route = (name: string, command: string): string =>
  `echo "== route ${name}"; ${command} 2>&1; echo "== exit ${name}=$?"`;

function routes(log: string): Map<string, { exit: number; out: string }> {
  const out = new Map<string, { exit: number; out: string }>();
  for (const m of log.matchAll(/^== route (\S+)\r?\n([\s\S]*?)^== exit \1=(\d+)/gm)) out.set(m[1]!, { exit: Number(m[3]), out: m[2]! });
  return out;
}

describe('a read-only need box behind the egress proxy, with a minted read session (issue #1956, criterion 2)', () => {
  it('denies every write route at the policy-assert proxy; moto is unchanged', async () => {
    const { a, session, proxy, seeded } = await h.boot(moto.url, { proxyHost: '0.0.0.0' });
    const { keys } = await h.readSession(a, session);
    const port = new URL(proxy.url).port;
    const endpoint = `http://${HOST_ALIAS}:${port}`;
    const credential: NeedCredential = {
      profile: { operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/read` } },
      minted: { kind: 'aws', AccessKeyId: keys.AccessKeyId, SecretAccessKey: keys.SecretAccessKey, SessionToken: keys.SessionToken!, Expiration: keys.Expiration },
      reach: { kind: 'aws', region: REGION, stsEndpoint: endpoint },
    };
    const command = [
      `export AWS_ENDPOINT_URL=${endpoint} AWS_MAX_ATTEMPTS=1 AWS_PAGER=`,
      route('read', `aws s3api head-object --bucket ${BUCKET} --key ${STATE_KEY}`),
      route('aws-delete', `aws s3api delete-object --bucket ${BUCKET} --key ${STATE_KEY}`),
      route('aws-terminate', `aws ec2 terminate-instances --instance-ids ${seeded.instanceId}`),
      `cat > main.tf <<'HOPPER_TF'\n${workspace(endpoint)}HOPPER_TF`,
      route('tf-init', 'terraform init -input=false -no-color'),
      route('tf-plan', 'terraform plan -input=false -no-color'),
      route('tf-apply', 'terraform apply -input=false -no-color'),
      route('tf-apply-auto', 'terraform apply -auto-approve -input=false -no-color'),
      route('tf-real', `${REAL_TERRAFORM} apply -auto-approve -input=false -no-color`),
      route('curl-put', `curl -sS -o /dev/null -w '%{http_code}\\n' --aws-sigv4 aws:amz:${REGION}:s3 --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -H "x-amz-security-token: $AWS_SESSION_TOKEN" -X PUT --data-binary planted "$AWS_ENDPOINT_URL/${BUCKET}/planted-by-curl"`),
      route('sdk', `SDK_BUCKET=${BUCKET} SDK_KEY=${STATE_KEY} node ${SDK_SCRIPT}`),
      'true',
    ].join('\n');

    const before = await stateHash(proxy.url);
    const reached = proxy.log.length;
    const ofSession = () => proxy.log.slice(reached).filter((d) => d.accessKeyId === keys.AccessKeyId);
    const sandboxes = createSandboxes({
      runtime: runtime(), repo: repo(), runs: memorySandboxRuns(), instanceId: INSTANCE, network: 'none',
      egress: createEgress({ network: stack.network, proxy: stack.proxy, dir: stack.dir }),
      clock: { now: () => new Date() }, logger: { info() {}, warn() {} },
    });
    let log = '';
    const name = `hopper-acceptance-need-read-${process.pid}`;
    const r = await sandboxes.needStep('u1', {
      name, template: { image: BOX_BASE, tools: ['terraform', 'aws'], readOnly: true },
      env: needEnv({ command, outputs: [], credentials: [credential] }), reaches: [credential.reach], timeoutMs: 600_000, dir,
      files: { inputs },
    }, { log: (chunk) => { log += chunk; }, signal: new AbortController().signal, pollMs: 500 }, { jobId: 'job-need-read', step: 'step-need-read', template: 'infra-read' });
    expect(r.problem, log).toBeUndefined();
    expect(r.exit, log).toBe(0);
    const got = routes(log);
    const of = (k: string) => {
      const v = got.get(k);
      expect(v, `${k}\n${log}`).toBeDefined();
      return v!;
    };

    // The read goes through the egress proxy and the policy-assert proxy, with the minted session.
    expect(of('read').exit, of('read').out).toBe(0);
    // The aws CLI: denied at the proxy.
    for (const k of ['aws-delete', 'aws-terminate']) {
      expect(of(k).exit, k).not.toBe(0);
      expect(of(k).out, k).toMatch(/AccessDenied|UnauthorizedOperation|403/);
    }
    // terraform: init and plan work; the wrapper refuses apply; the real binary is denied at the proxy.
    expect(of('tf-init').exit, of('tf-init').out).toBe(0);
    expect(of('tf-plan').exit, of('tf-plan').out).toBe(0);
    expect(of('tf-plan').out).toMatch(/Plan: 1 to add, 0 to change, 0 to destroy/);
    for (const k of ['tf-apply', 'tf-apply-auto']) {
      expect(of(k).exit, k).not.toBe(0);
      expect(of(k).out, k).toContain(WRAPPER_REFUSAL);
    }
    expect(of('tf-real').exit, of('tf-real').out).not.toBe(0);
    expect(of('tf-real').out).toMatch(/AccessDenied|403/);
    // curl's own SigV4: a PUT answered 403.
    expect(of('curl-put').out.trim()).toMatch(/^403$/m);
    // The SDK script: it reads, and its put and delete are denied.
    expect(of('sdk').out).toMatch(/^sdk get ok$/m);
    expect(of('sdk').out).toMatch(/^sdk put failed \S+ 403$/m);
    expect(of('sdk').out).toMatch(/^sdk delete failed \S+ 403$/m);

    // The proxy saw each write and denied it; it allowed the session no write.
    const denied = (action: string, path?: RegExp) => ofSession().filter((d) => !d.allowed && d.action === action && (!path || path.test(d.path)));
    expect(denied('s3:DeleteObject').length, 'aws CLI and SDK deletes').toBeGreaterThanOrEqual(2);
    expect(denied('ec2:TerminateInstances').length).toBeGreaterThanOrEqual(1);
    expect(denied('s3:CreateBucket').length).toBeGreaterThanOrEqual(1);
    expect(denied('s3:PutObject', /planted-by-curl$/).length).toBe(1);
    expect(denied('s3:PutObject', /planted-by-sdk$/).length).toBe(1);
    const allowed = ofSession().filter((d) => d.allowed && !/^(s3:(Get|List|Head)|ec2:Describe|sts:GetCallerIdentity)/.test(d.action ?? ''));
    expect(allowed, JSON.stringify(allowed)).toEqual([]);
    expect(await stateHash(proxy.url)).toBe(before);

    // The box and its home volume are burned after the step.
    expect((await cli(['ps', '-a', '-q', '--filter', `label=${NEED_LABEL}=${INSTANCE}`])).stdout.trim()).toBe('');
    expect((await cli(['volume', 'ls', '-q'])).stdout.split('\n')).not.toContain(`${name}-home`);
  }, 900_000);
});
