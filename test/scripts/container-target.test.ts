// scripts/container-target.sh <container> [lanes]: starts a container target (issue #58, design.md
// "Container targets") — a plain alpine container with no network, no agent and no ssh — and prints
// the plugins.yaml lines that attach it. Real docker; the container is removed afterwards.
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'container-target.sh');
const NAME = `jh-script-target-${process.pid}`;
const inspect = (format: string): string => execFileSync('docker', ['container', 'inspect', '--format', format, NAME], { encoding: 'utf8' }).trim();

afterAll(() => { spawnSync('docker', ['rm', '-f', NAME]); });

describe('container-target.sh', () => {
  it('starts the container without network, restarted with docker, and prints its attachedMachines entry', () => {
    const r = spawnSync('bash', [SCRIPT, NAME, '2'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(inspect('{{.State.Running}} {{.HostConfig.NetworkMode}} {{.HostConfig.RestartPolicy.Name}} {{.HostConfig.ReadonlyRootfs}}')).toBe('true none unless-stopped true');
    expect(r.stdout).toContain(`  - { name: ${NAME}, docker: ${NAME}, lanes: 2, executors: [command] }`);
    expect(execFileSync('docker', ['exec', NAME, 'sh', '-c', 'echo ok'], { encoding: 'utf8' })).toBe('ok\n');
  });

  it('running it again keeps the running container', () => {
    const id = inspect('{{.Id}}');
    const r = spawnSync('bash', [SCRIPT, NAME], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(inspect('{{.Id}}')).toBe(id);
  });

  it('refuses a name that is an option', () => {
    expect(spawnSync('bash', [SCRIPT, '-x'], { encoding: 'utf8' }).status).toBe(2);
  });
});
