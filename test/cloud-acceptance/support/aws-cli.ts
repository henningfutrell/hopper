// The real `aws` CLI (and curl) for the cloud acceptance tests (issue #1956), in the AWS CLI's own image, on the host's network so
// it reaches the policy-assert proxy on loopback. The container CLI is HOPPER_TEST_CONTAINER_CLI, else docker (podman's
// docker command works too). Credentials go in as environment variables of that one container, never on its command line.
import { execFile } from 'node:child_process';
import { containerLabels } from '../../support/sweep.ts';

export const AWS_CLI_IMAGE = process.env.AWS_CLI_IMAGE ?? 'docker.io/amazon/aws-cli:2.31.18';
const CLI = process.env.HOPPER_TEST_CONTAINER_CLI ?? 'docker';

export interface AwsKeys { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string }
export interface Run { code: number; stdout: string; stderr: string }

/** `aws <args>` against `endpoint` with `keys`; its exit code and output. */
export const aws = (endpoint: string, keys: AwsKeys, args: string[]): Promise<Run> => inImage(keys, ['--endpoint-url', endpoint, ...args]);

/**
 * `curl <args>` from the same image, signing with `keys` by curl's own SigV4 (`--aws-sigv4`). The keys reach curl as its
 * variables, read from the environment, so they are on no command line.
 */
export const curl = (keys: AwsKeys, args: string[]): Promise<Run> => inImage(keys, [
  '--variable', '%AWS_ACCESS_KEY_ID', '--variable', '%AWS_SECRET_ACCESS_KEY', '--expand-user', '{{AWS_ACCESS_KEY_ID}}:{{AWS_SECRET_ACCESS_KEY}}',
  ...(keys.SessionToken ? ['--variable', '%AWS_SESSION_TOKEN', '--expand-header', 'x-amz-security-token: {{AWS_SESSION_TOKEN}}'] : []),
  ...args,
], 'curl');

function inImage(keys: AwsKeys, args: string[], entrypoint?: string): Promise<Run> {
  const labels = Object.entries(containerLabels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const env = { AWS_ACCESS_KEY_ID: keys.AccessKeyId, AWS_SECRET_ACCESS_KEY: keys.SecretAccessKey, ...(keys.SessionToken ? { AWS_SESSION_TOKEN: keys.SessionToken } : {}) };
  const argv = ['run', '--rm', '--network', 'host', ...labels, ...Object.keys(env).flatMap((k) => ['-e', k]),
    '-e', 'AWS_DEFAULT_REGION=us-east-1', '-e', 'AWS_MAX_ATTEMPTS=1', '-e', 'AWS_PAGER=', ...(entrypoint ? ['--entrypoint', entrypoint] : []), AWS_CLI_IMAGE, ...args];
  return new Promise((resolve) => {
    execFile(CLI, argv, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}
