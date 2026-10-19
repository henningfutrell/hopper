// The mock AWS of the cloud acceptance tests (issue #1956): a moto server (STS, IAM, S3, EC2, KMS, SQS) in a throwaway
// container, seeded with what an infra job reads, and a hash of its state, so a test sees that a denied call changed
// nothing. HOPPER_TEST_MOTO_URL names a moto that is already up (a seat whose testcontainers hangs) instead.
import { createHash } from 'node:crypto';
import { CreateBucketCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DescribeImagesCommand, DescribeInstancesCommand, EC2Client, RunInstancesCommand } from '@aws-sdk/client-ec2';
import { CreateRoleCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, ListRolesCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { CreateKeyCommand, DescribeKeyCommand, KMSClient, ListKeysCommand } from '@aws-sdk/client-kms';
import { CreateQueueCommand, GetQueueAttributesCommand, ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { containerLabels } from '../../support/sweep.ts';

export const MOTO_IMAGE = process.env.MOTO_IMAGE ?? 'docker.io/motoserver/moto:5.1.14';
export const ACCOUNT = '123456789012';
export const REGION = 'us-east-1';
/** The seed's own key: moto takes any; the policy-assert proxy lets it do anything. */
export const SEED_KEYS = { accessKeyId: 'AKIASEEDACCEPTANCE', secretAccessKey: 'seed-secret-not-real' };
export const BUCKET = 'hopper-acceptance';
export const STATE_KEY = 'terraform/acceptance.tfstate';
export const READ_ROLE = `arn:aws:iam::${ACCOUNT}:role/read`;
export const WRITE_ROLE = `arn:aws:iam::${ACCOUNT}:role/write`;

export interface Seeded { instanceId: string; keyId: string; queueUrl: string }
export interface Moto { url: string; stop(): Promise<void> }

/** A moto server: HOPPER_TEST_MOTO_URL's, or a new container stopped by `stop`. */
export async function startMoto(): Promise<Moto> {
  if (process.env.HOPPER_TEST_MOTO_URL) return { url: process.env.HOPPER_TEST_MOTO_URL.replace(/\/$/, ''), stop: async () => {} };
  const c: StartedTestContainer = await new GenericContainer(MOTO_IMAGE).withExposedPorts(5000).withLabels(containerLabels())
    .withWaitStrategy(Wait.forHttp('/moto-api/', 5000)).start();
  return { url: `http://${c.getHost()}:${c.getMappedPort(5000)}`, stop: async () => { await c.stop(); } };
}

/** Clears every resource moto holds, so each test starts from the seed alone. */
export async function resetMoto(url: string): Promise<void> {
  const res = await fetch(`${url}/moto-api/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`moto reset: ${res.status}`);
}

const clientConfig = (endpoint: string) => ({ endpoint, region: REGION, credentials: SEED_KEYS, maxAttempts: 1 });

/**
 * The seed: a read role, a write role and topology discovery's read role `hopper-read`, each with full access of its own
 * (so whatever a read session cannot do, its session policy denies), an S3 bucket with a terraform state of the seeded
 * resources, an EC2 instance, a KMS key and an SQS queue. Through `endpoint`: the policy-assert proxy, which lets the seed's key through (and makes moto's two
 * Date headers one, which the AWS SDK needs).
 */
export async function seed(endpoint: string): Promise<Seeded> {
  const iam = new IAMClient(clientConfig(endpoint));
  const s3 = new S3Client({ ...clientConfig(endpoint), forcePathStyle: true });
  const ec2 = new EC2Client(clientConfig(endpoint));
  const kms = new KMSClient(clientConfig(endpoint));
  const sqs = new SQSClient(clientConfig(endpoint));
  try {
    const trust = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: 'sts:AssumeRole' }] });
    const all = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] });
    for (const name of ['read', 'write', 'hopper-read']) {
      await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: trust, MaxSessionDuration: 3600 }));
      await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: 'all', PolicyDocument: all }));
    }
    const image = (await ec2.send(new DescribeImagesCommand({}))).Images?.[0]?.ImageId;
    if (!image) throw new Error('moto lists no image to run an instance of');
    const instanceId = (await ec2.send(new RunInstancesCommand({ ImageId: image, MinCount: 1, MaxCount: 1, InstanceType: 't3.micro' }))).Instances?.[0]?.InstanceId;
    const keyId = (await kms.send(new CreateKeyCommand({ Description: 'hopper acceptance' }))).KeyMetadata?.KeyId;
    const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: 'hopper-acceptance' }))).QueueUrl;
    if (!instanceId || !keyId || !queueUrl) throw new Error('moto answered no id for a seeded resource');
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: STATE_KEY, Body: terraformState({ instanceId, keyId, queueUrl }), ContentType: 'application/json' }));
    return { instanceId, keyId, queueUrl };
  } finally {
    for (const c of [iam, s3, ec2, kms, sqs]) c.destroy();
  }
}

/** A terraform state (format 4) of the seeded resources, as `terraform apply` of them would have written it. */
function terraformState(s: Seeded): string {
  const resource = (type: string, name: string, attributes: Record<string, unknown>) => ({ mode: 'managed', type, name, provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ schema_version: 0, attributes }] });
  return JSON.stringify({
    version: 4, terraform_version: '1.9.8', serial: 1, lineage: '00000000-0000-4000-8000-000000001956', outputs: {},
    resources: [
      resource('aws_s3_bucket', 'acceptance', { id: BUCKET, bucket: BUCKET }),
      resource('aws_instance', 'acceptance', { id: s.instanceId, instance_type: 't3.micro' }),
      resource('aws_kms_key', 'acceptance', { id: s.keyId, key_id: s.keyId }),
      resource('aws_sqs_queue', 'acceptance', { id: s.queueUrl, name: 'hopper-acceptance' }),
    ],
  }, null, 2);
}

/**
 * A hash of what the seed made and a job could change, read from moto with the seed's key: the buckets and their objects
 * (with ETags), the instances and their states, the keys and their states, the queues and their attributes, the roles
 * and their policies. moto's own state dump leaves out most of these, so the snapshot reads them itself. Through `url`:
 * the policy-assert proxy, as for the seed.
 */
export async function stateHash(url: string): Promise<string> {
  const iam = new IAMClient(clientConfig(url));
  const s3 = new S3Client({ ...clientConfig(url), forcePathStyle: true });
  const ec2 = new EC2Client(clientConfig(url));
  const kms = new KMSClient(clientConfig(url));
  const sqs = new SQSClient(clientConfig(url));
  try {
    const buckets = [];
    for (const b of (await s3.send(new ListBucketsCommand({}))).Buckets ?? []) {
      const objects = (await s3.send(new ListObjectsV2Command({ Bucket: b.Name! }))).Contents ?? [];
      buckets.push({ name: b.Name, objects: objects.map((o) => [o.Key, o.ETag, o.Size]) });
    }
    const instances = ((await ec2.send(new DescribeInstancesCommand({}))).Reservations ?? []).flatMap((r) => r.Instances ?? [])
      .map((i) => [i.InstanceId, i.State?.Name, i.InstanceType, (i.Tags ?? []).map((t) => `${t.Key}=${t.Value}`).sort()]);
    const keys = [];
    for (const k of (await kms.send(new ListKeysCommand({}))).Keys ?? []) {
      const m = (await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId! }))).KeyMetadata;
      keys.push([m?.KeyId, m?.KeyState, m?.Enabled, m?.Description]);
    }
    const queues = [];
    for (const q of (await sqs.send(new ListQueuesCommand({}))).QueueUrls ?? []) {
      const a = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: q, AttributeNames: ['All'] }))).Attributes ?? {};
      queues.push([q, a.ApproximateNumberOfMessages, a.VisibilityTimeout, a.Policy ?? '']);
    }
    const roles = [];
    for (const r of (await iam.send(new ListRolesCommand({}))).Roles ?? []) {
      roles.push([r.RoleName, r.MaxSessionDuration, (await iam.send(new ListRolePoliciesCommand({ RoleName: r.RoleName! }))).PolicyNames ?? [],
        ((await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: r.RoleName! }))).AttachedPolicies ?? []).map((p) => p.PolicyArn)]);
    }
    const state = { buckets, instances, keys, queues, roles };
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  } finally {
    for (const c of [iam, s3, ec2, kms, sqs]) c.destroy();
  }
}
