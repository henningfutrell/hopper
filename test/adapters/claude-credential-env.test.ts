// The claude CLI's credential reaches a job's Claude (issue #533): a hopper in a container is given
// CLAUDE_CODE_OAUTH_TOKEN (docs/deploy.md), and its herdr server — whose environment every pane inherits — starts
// from the scrubbed environment, which dropped every CLAUDE_CODE_* variable, so Claude there stopped at its login
// screen. The scrub keeps the credential, still drops the child-session markers, and a user added later never gets
// admin's.
import { describe, expect, it } from 'vitest';
import { scrubbedEnv, userProcessEnv } from '../../src/executors/env.ts';

describe('the scrubbed environment and the claude CLI credential', () => {
  it('keeps CLAUDE_CODE_OAUTH_TOKEN; drops CLAUDECODE and every other CLAUDE_CODE_* variable', () => {
    const env = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1' };
    expect(scrubbedEnv(env)).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });

  it('a user added later never gets the daemon\'s credential', () => {
    expect(scrubbedEnv(userProcessEnv({ CLAUDE_CONFIG_DIR: '/u/claude' }, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }))).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/u/claude' });
  });
});
