// Issue #324: a job's payload carries its own work tree (`cwd`) apart from its source's default
// (`defaultCwd`), so a machine's work tree can come between them.
import { describe, expect, it } from 'vitest';
import { validatePayload } from '../../src/executors/herdr/index.ts';

describe('herdr-claude payload defaultCwd', () => {
  it('accepts an absolute path or one under ~', () => {
    expect(validatePayload({ prompt: 'p', defaultCwd: '~/jobs' })).toBeNull();
    expect(validatePayload({ prompt: 'p', defaultCwd: '/srv/jobs' })).toBeNull();
  });

  it('refuses a relative path', () => {
    expect(validatePayload({ prompt: 'p', defaultCwd: 'jobs' })).toBe('defaultCwd must be an absolute path or start with ~');
  });
});
