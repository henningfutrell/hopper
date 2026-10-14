// The test files that need a host service beyond the suite's own Postgres: containers they start
// themselves (docker), a real sshd, a real LDAP directory, a real vault. The pull request check
// (.github/workflows/pr.yml, issue #672) runs on a clean runner with HOPPER_TEST_HOST_SERVICES=0 and
// leaves them out; everywhere else they run. A new test that needs one of those services goes here.
// A machine with no container runtime at all (a seat with no docker or podman socket, issue #1038) also
// leaves out the tests that start a container of their own (CONTAINER_TESTS), and says why.
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { configDefaults } from 'vitest/config';

export const HOST_SERVICE_TESTS = [
  'test/adapters/command-executor.test.ts',
  'test/integration/container-target.test.ts',
  'test/integration/realms-ldap.test.ts',
  'test/integration/ssh-auth-real.test.ts',
  'test/integration/ssh-no-dot-ssh-real.test.ts',
  'test/integration/vault-backends.test.ts',
  'test/plugins/vault-backends.test.ts',
  'test/scripts/container-target.test.ts',
  'test/scripts/docker-proxy.test.ts',
] as const;

/** The tests, beyond HOST_SERVICE_TESTS, that start a container of their own (testcontainers: Solr, a HashiCorp Vault). */
export const CONTAINER_TESTS = [
  'test/adapters/solr-index.test.ts',
  'test/adapters/solr-meter.test.ts',
  'test/integration/search.test.ts',
  'test/integration/system-backends.test.ts',
] as const;

export interface Machine {
  uid: number;
  home: string;
  exists(path: string): boolean;
  /** Whether this user may open the socket at `path`. */
  usable(path: string): boolean;
}

const thisMachine = (): Machine => ({
  uid: userInfo().uid,
  home: homedir(),
  exists: existsSync,
  usable: (p) => { try { accessSync(p, constants.R_OK | constants.W_OK); return true; } catch { return false; } },
});

/**
 * Whether the tests reach a container runtime. DOCKER_HOST or a testcontainers config is taken as it is. Else the
 * docker socket testcontainers picks itself (the first that exists) when this user may open it; else the first usable
 * docker or podman socket, named in `env` as DOCKER_HOST, so testcontainers and the docker CLI use it (issue #1038: a
 * root docker socket this user may not open hid rootless podman).
 */
export function containerRuntime(env: Record<string, string | undefined>, m: Machine = thisMachine()): boolean {
  if (env.DOCKER_HOST || m.exists(join(m.home, '.testcontainers.properties'))) return true;
  const run = env.XDG_RUNTIME_DIR;
  const docker = ['/var/run/docker.sock', ...(run ? [join(run, 'docker.sock')] : []), join(m.home, '.docker', 'run', 'docker.sock'),
    join(m.home, '.docker', 'desktop', 'docker.sock'), `/run/user/${m.uid}/docker.sock`];
  const podman = [...(run ? [join(run, 'podman', 'podman.sock')] : []), `/run/user/${m.uid}/podman/podman.sock`];
  const picked = docker.find((p) => m.exists(p));
  if (picked !== undefined && m.usable(picked)) return true;
  const usable = [...docker, ...podman].find((p) => m.exists(p) && m.usable(p));
  if (usable === undefined) return false;
  env.DOCKER_HOST = `unix://${usable}`;
  return true;
}

export interface Runtime {
  runtime: boolean;
  say(line: string): void;
}

/**
 * vitest's exclude: its defaults, the host-service tests when HOPPER_TEST_HOST_SERVICES is 0, and with no container
 * runtime every test that starts a container, said in `say`.
 */
export function testExclude(env: Record<string, string | undefined>, r: Runtime = { runtime: true, say: () => {} }): string[] {
  if (!r.runtime) {
    const skipped = [...HOST_SERVICE_TESTS, ...CONTAINER_TESTS];
    r.say(`hopper tests: no docker or podman socket this user may open, so ${skipped.length} test files that start containers are skipped (environment skips, not failures). Set DOCKER_HOST to run them:`);
    for (const f of skipped) r.say(`  skipped: ${f}`);
    return [...configDefaults.exclude, ...skipped];
  }
  return env.HOPPER_TEST_HOST_SERVICES === '0' ? [...configDefaults.exclude, ...HOST_SERVICE_TESTS] : [...configDefaults.exclude];
}
