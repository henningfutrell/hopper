// The SDK script of the cloud acceptance tests (issue #1956, criterion 2 inside a box): what a job's own script does with
// the AWS SDK in a need box. It is not run here: `sdkScript` (box-sdk-bundle.ts) bundles it with the SDK into one file,
// which goes into the box as the step's input and runs on the box's node. The SDK's own HTTP agent goes through the
// box's proxy (HTTP_PROXY, as node's `proxyEnv` reads it); its keys are the box's AWS variables, its endpoint
// AWS_ENDPOINT_URL. Each call prints one line: `sdk <call> ok`, or `sdk <call> failed <error name> <HTTP status>`.
import { Agent, type AgentOptions } from 'node:http';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const bucket = process.env.SDK_BUCKET!, key = process.env.SDK_KEY!;
const agent = new Agent({ proxyEnv: process.env } as AgentOptions & { proxyEnv: NodeJS.ProcessEnv });
const s3 = new S3Client({
  region: process.env.AWS_REGION!, endpoint: process.env.AWS_ENDPOINT_URL!, forcePathStyle: true, maxAttempts: 1,
  requestHandler: { httpAgent: agent },
});

const calls: [string, () => Promise<unknown>][] = [
  ['get', () => s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))],
  ['put', () => s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'planted-by-sdk', Body: 'planted' }))],
  ['delete', () => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))],
];
for (const [name, call] of calls) {
  try {
    await call();
    process.stdout.write(`sdk ${name} ok\n`);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    process.stdout.write(`sdk ${name} failed ${err.name ?? 'Error'} ${err.$metadata?.httpStatusCode ?? 0}\n`);
  }
}
