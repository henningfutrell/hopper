// Issue #1956 (acceptance criteria 1 and 2): a read session the vault mints, used against a mock AWS (moto) behind the
// policy-assert proxy, which re-checks every SigV4 call against the session's own policies. The hopper is the real
// composition root, its vault mints through the real STS adapter (to the proxy, then moto), and a joined client's
// helper hands the session to the job as a box's job gets it. The calls are made by the real `aws` CLI, curl's own
// SigV4 and the AWS SDK. Not part of `npm test`: `npm run test:cloud` (vitest.cloud.config.ts), nightly in CI.
//
// Feature: a read template's session is scoped and read-only by every route
//   Scenario: minted scope
//     Given the minting credential AWS_LAB for account 123456789012, with the session name hopper-acceptance
//     And the template infra-read, approved, which declares read on aws-role/123456789012/read
//     When a job on its box runs `$HOPPER_SECRET aws read aws-role/123456789012/read`
//     Then STS was asked for a session of the role read, named hopper-acceptance, for 900 s at most
//     And the session carries ReadOnlyAccess and the hopper's inline deny policy
//     And the box's client dir and the job's environment hold no key: only the helper
//   Scenario: read-only by every route
//     When the session reads the seeded bucket, instance, key and queue with the aws CLI
//     Then every read is allowed
//     When it deletes, terminates, schedules deletion and puts with the aws CLI, with curl's SigV4 PUT, and with the SDK
//     Then the proxy denies each, nothing denied reaches moto, and moto's state hash is the same before and after
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EC2Client, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AWS_SESSION_SECONDS, awsReadSession } from '../../src/domain/minting.ts';
import { READ_ONLY_ACCESS } from '../support/policy-assert-proxy.ts';
import { aws, curl } from './support/aws-cli.ts';
import { cloudHopper, MINTING, SESSION_NAME } from './support/hopper.ts';
import { ACCOUNT, BUCKET, READ_ROLE, REGION, startMoto, stateHash, STATE_KEY, type Moto } from './support/moto.ts';

let moto: Moto;
const h = cloudHopper();

beforeAll(async () => { moto = await startMoto(); }, 180_000);
afterAll(async () => { await moto?.stop(); });
afterEach(() => h.end());

describe('a read template\'s session against a mock AWS behind the policy-assert proxy (issue #1956)', () => {
  it('minted scope: ReadOnlyAccess and the deny policy, the template\'s lifetime, the configured session name; no key on the box', async () => {
    const { a, session, proxy } = await h.boot(moto.url);
    const { dir, keys, mintedAt } = await h.readSession(a, session);
    const minted = proxy.sessions.get(keys.AccessKeyId);
    expect(minted).toMatchObject({ roleArn: READ_ROLE, sessionName: SESSION_NAME, policyArns: [READ_ONLY_ACCESS], policy: awsReadSession(READ_ROLE).policy });
    expect(minted!.durationSeconds).toBeLessThanOrEqual(AWS_SESSION_SECONDS);
    // moto's own answer: the session ends within the template's lifetime of the mint.
    expect(Date.parse(keys.Expiration) - mintedAt).toBeLessThanOrEqual(AWS_SESSION_SECONDS * 1000 + 5000);
    expect(Math.floor(Date.parse(minted!.expiration) / 1000)).toBe(Math.floor(Date.parse(keys.Expiration) / 1000));
    // The session works, as the role it was minted for.
    const who = await aws(proxy.url, keys, ['sts', 'get-caller-identity', '--output', 'json']);
    expect(who.code, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout).Arn).toBe(`arn:aws:sts::${ACCOUNT}:assumed-role/read/${SESSION_NAME}`);
    // The box holds the helper and its link, never a key: the minting credential stays in the hopper, the session goes
    // only to the job that asked, on the helper's stdout.
    for (const f of readdirSync(dir).filter((x) => x !== 'vault.sock')) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const secret of [MINTING.SecretAccessKey, keys.SecretAccessKey, keys.SessionToken!]) expect(text, f).not.toContain(secret);
    }
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(keys.SecretAccessKey);
  }, 120_000);

  it('read-only by every route: the aws CLI, curl\'s SigV4 and the SDK may read but not write; moto is unchanged', async () => {
    const { a, session, seeded, proxy } = await h.boot(moto.url);
    const { keys } = await h.readSession(a, session);
    const url = proxy.url;
    const reads = [
      ['s3', 'ls', `s3://${BUCKET}/terraform/`], ['s3api', 'get-object', '--bucket', BUCKET, '--key', STATE_KEY, '/tmp/state'],
      ['ec2', 'describe-instances', '--instance-ids', seeded.instanceId], ['kms', 'describe-key', '--key-id', seeded.keyId],
      ['sqs', 'get-queue-attributes', '--queue-url', seeded.queueUrl, '--attribute-names', 'All'],
    ];
    for (const args of reads) {
      const r = await aws(url, keys, args);
      expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0);
    }
    const before = await stateHash(url);
    const reached = proxy.log.length;

    const writes = [
      ['s3api', 'delete-object', '--bucket', BUCKET, '--key', STATE_KEY], ['s3api', 'delete-bucket', '--bucket', BUCKET],
      ['s3api', 'put-object', '--bucket', BUCKET, '--key', 'planted', '--body', '/etc/hostname'],
      ['ec2', 'terminate-instances', '--instance-ids', seeded.instanceId], ['ec2', 'create-tags', '--resources', seeded.instanceId, '--tags', 'Key=k,Value=v'],
      ['kms', 'schedule-key-deletion', '--key-id', seeded.keyId, '--pending-window-in-days', '7'],
      ['sqs', 'delete-queue', '--queue-url', seeded.queueUrl], ['sqs', 'send-message', '--queue-url', seeded.queueUrl, '--message-body', 'x'],
      ['iam', 'attach-role-policy', '--role-name', 'read', '--policy-arn', 'arn:aws:iam::aws:policy/AdministratorAccess'],
      ['sts', 'assume-role', '--role-arn', `arn:aws:iam::${ACCOUNT}:role/write`, '--role-session-name', 'escape'],
    ];
    for (const args of writes) {
      const r = await aws(url, keys, args);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).toMatch(/AccessDenied/);
    }
    // A raw SigV4 PUT, signed by curl itself.
    const put = await curl(keys, ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--aws-sigv4', `aws:amz:${REGION}:s3`, '-X', 'PUT', '--data-binary', 'planted', `${url}/${BUCKET}/planted-by-curl`]);
    expect(put.stdout).toBe('403');
    // The SDK, as a job's script would use it.
    const credentials = { accessKeyId: keys.AccessKeyId, secretAccessKey: keys.SecretAccessKey, sessionToken: keys.SessionToken! };
    const config = { endpoint: url, region: REGION, credentials, maxAttempts: 1 };
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    const ec2 = new EC2Client(config);
    const sqs = new SQSClient(config);
    try {
      await expect(s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: STATE_KEY }))).rejects.toThrow(/policy-assert/);
      await expect(ec2.send(new TerminateInstancesCommand({ InstanceIds: [seeded.instanceId] }))).rejects.toThrow(/policy-assert/);
      await expect(sqs.send(new DeleteQueueCommand({ QueueUrl: seeded.queueUrl }))).rejects.toThrow(/policy-assert/);
    } finally {
      for (const c of [s3, ec2, sqs]) c.destroy();
    }

    expect(await stateHash(url)).toBe(before);
    const tried = proxy.log.slice(reached).filter((d) => d.accessKeyId === keys.AccessKeyId);
    expect(tried.length).toBeGreaterThanOrEqual(writes.length + 4);
    expect(tried.filter((d) => d.allowed), JSON.stringify(tried.filter((d) => d.allowed))).toEqual([]);
    expect(new Set(tried.map((d) => d.action))).toEqual(new Set([
      's3:DeleteObject', 's3:DeleteBucket', 's3:PutObject', 'ec2:TerminateInstances', 'ec2:CreateTags', 'kms:ScheduleKeyDeletion',
      'sqs:DeleteQueue', 'sqs:SendMessage', 'iam:AttachRolePolicy', 'sts:AssumeRole',
    ]));
  }, 300_000);
});
