// A user added later starts their processes from the machine's variables only (issue #158, design.md
// "Users: one hopper, separate users"): the daemon's environment holds owner's runtime secrets, and a
// later user's gh, claude, herdr server and panes must not inherit them. Owner's processes are unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/executors/command.ts';
import { userProcessEnv } from '../../src/executors/env.ts';

const SECRET = 'HOPPER_TEST_OWNER_SECRET';
afterEach(() => { delete process.env[SECRET]; });

const envOf = async (userEnv: Record<string, string>): Promise<string> => {
  const r = await run('/usr/bin/env', [], 5000, new AbortController().signal, userEnv);
  if (typeof r === 'string') throw new Error(r);
  return r.stdout;
};

describe('userProcessEnv', () => {
  it("is the daemon's environment for owner (no user env)", () => {
    const env = { PATH: '/bin', GITHUB_APP_PRIVATE_KEY: 'k' };
    expect(userProcessEnv({}, env)).toEqual(env);
  });

  it("keeps the machine's variables and the user's own for a user added later, never the daemon's secrets", () => {
    const env = { PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'xterm', GITHUB_APP_PRIVATE_KEY: 'k', GH_TOKEN: 't', SSH_AUTH_SOCK: '/s', HOPPER_DATABASE_URL: 'postgres://x' };
    expect(userProcessEnv({ GH_CONFIG_DIR: '/u/gh' }, env)).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'xterm', GH_CONFIG_DIR: '/u/gh' });
  });
});

describe('a process a user added later starts', () => {
  it("does not see a variable of the daemon's environment; owner's still does", async () => {
    process.env[SECRET] = 'owner-only';
    expect(await envOf({ GH_CONFIG_DIR: '/u/gh' })).not.toContain(SECRET);
    expect(await envOf({ GH_CONFIG_DIR: '/u/gh' })).toContain('GH_CONFIG_DIR=/u/gh');
    expect(await envOf({})).toContain(`${SECRET}=owner-only`);
  });
});
