// The read-only box of the cloud acceptance tests (issue #1956): the image a read-only template's box runs, made as the
// hopper makes it — `boxImage` (src/sandbox/box-image.ts) through the real container runtime, the published box image
// with terraform and the aws CLI added, terraform behind the read-only wrapper and installing providers only from the
// image's mirror. A box is one container of it, on the host's network so it reaches the policy-assert proxy on loopback,
// the read session's keys in its environment; each command is an exec in it. HOPPER_TEST_BOX_IMAGE names another base.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BOX_IMAGE, boxImage } from '../../../src/sandbox/box-image.ts';
import { createDockerRuntime } from '../../../src/sandbox/docker.ts';
import { createPodmanRuntime } from '../../../src/sandbox/podman.ts';
import { containerLabels } from '../../support/sweep.ts';
import type { AwsKeys, Run } from './aws-cli.ts';
import { REGION } from './moto.ts';

export const BOX_BASE = process.env.HOPPER_TEST_BOX_IMAGE ?? `${BOX_IMAGE}:box-claude`;
const CLI = process.env.HOPPER_TEST_CONTAINER_CLI ?? 'docker';
/** Where a tools image keeps the real binaries, behind the wrappers (src/sandbox/tools.ts). */
export const REAL_TERRAFORM = '/opt/hopper-tools/bin/terraform';

/** The read-only box image of a template that reads a terraform workspace (its tools: terraform and aws). */
export async function readOnlyBoxImage(): Promise<{ image: string; user: string }> {
  return boxImage(runtime(), BOX_BASE, ['terraform', 'aws'], true);
}

/**
 * The box image of a template that changes a terraform workspace (its tools: terraform and aws): terraform behind the
 * apply wrapper, which applies only the saved file of a plan the hopper recorded. Its providers come from the registry.
 */
export async function writeBoxImage(): Promise<{ image: string; user: string }> {
  return boxImage(runtime(), BOX_BASE, ['terraform', 'aws'], false);
}

function runtime() {
  const socket = (process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '');
  return CLI === 'podman' ? createPodmanRuntime(socket) : createDockerRuntime(socket);
}

export interface Box { exec(args: string[], o?: { env?: Record<string, string> }): Promise<Run>; end(): Promise<void> }

/** A box of `image` that holds `keys`, its work dir `dir`. */
export async function startBox(image: { image: string; user: string }, keys: AwsKeys, dir = 'work'): Promise<Box> {
  const name = `hopper-acceptance-box-${randomBytes(4).toString('hex')}`;
  const env = { AWS_ACCESS_KEY_ID: keys.AccessKeyId, AWS_SECRET_ACCESS_KEY: keys.SecretAccessKey, ...(keys.SessionToken ? { AWS_SESSION_TOKEN: keys.SessionToken } : {}) };
  const labels = Object.entries(containerLabels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const started = await cli(['run', '-d', '--rm', '--name', name, '--network', 'host', '--user', image.user, ...labels,
    ...Object.keys(env).flatMap((k) => ['-e', k]), '-e', `AWS_DEFAULT_REGION=${REGION}`, '-e', 'AWS_MAX_ATTEMPTS=1', '-e', 'AWS_PAGER=',
    '--entrypoint', 'sleep', image.image, 'infinity'], env);
  if (started.code !== 0) throw new Error(`the box did not start: ${started.stderr}`);
  const home = (await cli(['exec', name, 'sh', '-c', 'echo "$HOME"'])).stdout.trim();
  const work = `${home}/${dir}`;
  await cli(['exec', name, 'mkdir', '-p', work]);
  return {
    exec: (args, o = {}) => cli(['exec', '-w', work, ...Object.keys(o.env ?? {}).flatMap((k) => ['-e', k]), name, ...args], o.env ?? {}),
    end: async () => { await cli(['rm', '-f', '-t', '0', name]); },
  };
}

function cli(argv: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(CLI, argv, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}
