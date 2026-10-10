// The test files that need a host service beyond the suite's own Postgres: containers they start
// themselves (docker), a real sshd, a real LDAP directory, a real vault. The pull request check
// (.github/workflows/pr.yml, issue #672) runs on a clean runner with HOPPER_TEST_HOST_SERVICES=0 and
// leaves them out; everywhere else they run. A new test that needs one of those services goes here.
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

/** vitest's exclude: its defaults, and the host-service tests when HOPPER_TEST_HOST_SERVICES is 0. */
export const testExclude = (env: Record<string, string | undefined>): string[] =>
  env.HOPPER_TEST_HOST_SERVICES === '0' ? [...configDefaults.exclude, ...HOST_SERVICE_TESTS] : [...configDefaults.exclude];
