// scripts/docker-proxy.sh <container>...: the docker socket the hopper uses (issue #59, design.md
// "Target authentication") — an allowlisting socket proxy, restarted with docker, listening on a
// socket only this user may open, that lets through inspect and exec on the named containers only.
// Real docker; everything is removed afterwards.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerHost } from '../../src/executors/docker.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'docker-proxy.sh');
const PROXY = `jh-script-proxy-${process.pid}`;
const TARGET = `jh-script-dp-target-${process.pid}`;
const OTHER = `jh-script-dp-other-${process.pid}`;
let dir: string;
const env = () => ({ ...process.env, JOB_HOPPER_DOCKER_DIR: dir, JOB_HOPPER_DOCKER_PROXY_NAME: PROXY });
const docker = (args: string[]) => spawnSync('docker', ['--host', `unix://${join(dir, 'docker.sock')}`, ...args], { encoding: 'utf8' });

beforeAll(() => {
  dir = mkdtempSync('/tmp/jh-dps-');
  for (const c of [TARGET, OTHER]) execFileSync('docker', ['run', '-d', '--rm', '--name', c, '--network', 'none', 'alpine:latest', 'sleep', '600'], { stdio: 'ignore' });
}, 60000);
afterAll(() => {
  spawnSync('docker', ['rm', '-f', PROXY, TARGET, OTHER]);
  rmSync(dir, { recursive: true, force: true });
});

describe('docker-proxy.sh', () => {
  it('starts the proxy restarted with docker, its socket only this user may open, and prints the setting', () => {
    const r = spawnSync('bash', [SCRIPT, TARGET], { encoding: 'utf8', env: env() });
    expect(r.status, r.stderr).toBe(0);
    expect(execFileSync('docker', ['container', 'inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}} {{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}}', PROXY], { encoding: 'utf8' }).trim())
      .toBe('true unless-stopped none true');
    const sock = join(dir, 'docker.sock');
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(r.stdout).toContain(`JOB_HOPPER_DOCKER_HOST=unix://${sock}`);
    expect(dockerHost(() => `unix://${sock}`)).toBe(`unix://${sock}`);
  });

  it('lets through exec and inspect on the named container, and nothing else', () => {
    expect(docker(['exec', TARGET, 'echo', 'in']).stdout).toBe('in\n');
    expect(docker(['container', 'inspect', '--format', '{{.State.Running}}', TARGET]).stdout.trim()).toBe('true');
    for (const refused of [['exec', OTHER, 'true'], ['ps'], ['images'], ['run', '--rm', 'alpine:latest', 'true']]) {
      const r = docker(refused);
      expect(r.status, refused.join(' ')).not.toBe(0);
      expect(r.stderr).toMatch(/Forbidden/);
    }
  });

  it('run again with another set of containers: the allowlist follows it', () => {
    expect(spawnSync('bash', [SCRIPT, TARGET, OTHER], { encoding: 'utf8', env: env() }).status).toBe(0);
    expect(docker(['exec', OTHER, 'echo', 'now']).stdout).toBe('now\n');
  });

  it('refuses no container, or a name that is an option', () => {
    expect(spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: env() }).status).toBe(2);
    expect(spawnSync('bash', [SCRIPT, '-x'], { encoding: 'utf8', env: env() }).status).toBe(2);
  });
});
