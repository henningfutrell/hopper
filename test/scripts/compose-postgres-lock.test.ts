// Issue #1063: a second compose stack — another compose tool, which does not see the stack that runs — mounts the same
// named volumes, and its Postgres started on the live data directory. Postgres's own postmaster.pid check does not work
// across containers (in each one the database is PID 1), so compose.yaml's Postgres locks its data volume first of all.
// Asserted on the rendered form compose runs (`docker compose config`), and with real containers where Docker answers.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Postgres { image: string; entrypoint: string[]; command: string[]; environment?: Record<string, string | null> }

/** compose.yaml's postgres service, rendered from compose.yaml alone in a fresh directory. */
function postgresService(): Postgres {
  const dir = mkdtempSync(join(tmpdir(), 'jh-compose-'));
  try {
    copyFileSync(join(ROOT, 'compose.yaml'), join(dir, 'compose.yaml'));
    const out = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    });
    expect(out.status, out.stderr).toBe(0);
    return (JSON.parse(out.stdout) as { services: { postgres: Postgres } }).services.postgres;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('one Postgres per data volume (issue #1063)', () => {
  const pg = postgresService();

  it('locks its data volume before anything else: a second Postgres on it stops at once', () => {
    const script = pg.command.join('\n');
    expect(script).toMatch(/^exec 9< \/var\/lib\/postgresql\/data\nflock -n 9 \|\| \{[^\n]*exit 75; \}\n/);
    expect(script.indexOf('flock -n 9')).toBeLessThan(script.indexOf('rm -f'));
  });
});

// For real: two Postgres containers of compose.yaml's service on one data volume. The second stops before it writes
// anything (exit 75), and the first runs on. It needs Docker, or Podman's socket as DOCKER_HOST (the test setup names it);
// elsewhere skipped. Not the podman CLI: under the test's throwaway HOME it keeps its storage there, in files the test
// cannot remove.
const RUNTIME = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 ? 'docker' : undefined;

describe.skipIf(!RUNTIME)('one Postgres per data volume, real containers (issue #1063)', () => {
  it('a second Postgres container on a data volume in use does not start, and the first runs on', () => {
    const rt = RUNTIME!;
    const pg = postgresService();
    const p = `jh1063-${randomBytes(4).toString('hex')}`;
    const run = (args: string[]) => spawnSync(rt, args, { encoding: 'utf8', timeout: 120_000 });
    const mounts = ['-v', `${p}-postgres:/var/lib/postgresql/data`, '-v', `${p}-secrets:/run/hopper-secrets`, '-v', `${p}-tunnel:/run/hopper-tunnel`];
    const env = Object.entries(pg.environment ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v ?? ''}`]);
    const start = (name: string, detach: boolean) => run([
      // No pids limit: the docker CLI on Podman's socket gets one so low the shell cannot fork.
      'run', ...(detach ? ['-d'] : []), '--name', name, '--network', 'none', '--pids-limit', '-1', ...env, ...mounts,
      '--entrypoint', pg.entrypoint[0]!, pg.image, ...pg.entrypoint.slice(1), ...pg.command.map((c) => c.replaceAll('$$', '$')), // `compose config` keeps compose's `$$`
    ]);
    try {
      const first = start(`${p}-a`, true);
      expect(first.status, first.stderr).toBe(0);
      const until = Date.now() + 90_000;
      while (run(['exec', `${p}-a`, 'test', '-f', '/run/hopper-secrets/password_set']).status !== 0) {
        expect(Date.now(), run(['logs', `${p}-a`]).stderr).toBeLessThan(until);
        spawnSync('sleep', ['1']);
      }
      const second = start(`${p}-b`, false);
      expect(second.status, second.stderr).toBe(75);
      expect(second.stderr).toMatch(/another container runs on this data volume/);
      expect(run(['inspect', '-f', '{{.State.Running}}', `${p}-a`]).stdout.trim()).toBe('true');
      // The second one stopped before it touched the start files the first one made.
      expect(run(['exec', `${p}-a`, 'test', '-f', '/run/hopper-secrets/password_set']).status).toBe(0);
      expect(run(['logs', `${p}-a`]).stderr).not.toMatch(/lock file is invalid/);
    } finally {
      run(['rm', '-f', `${p}-a`, `${p}-b`]);
      run(['volume', 'rm', '-f', `${p}-postgres`, `${p}-secrets`, `${p}-tunnel`]);
    }
  }, 180_000);
});
