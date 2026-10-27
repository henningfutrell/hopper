// Issue #2849 part 5: a job's environment scope — the variable names its agent keeps of the machine's environment: the
// machine's own, the agent's sign-in, the user's and its repository's names. Every other variable is absent.
import { describe, expect, it } from 'vitest';
import { JOB_ENV_KEPT, jobEnvKeep, jobEnvNameProblem, NO_JOB_EGRESS, normalJobEgress } from '../../src/domain/job-egress.ts';

describe('a job environment name (issue #2849 part 5)', () => {
  it('is an upper-case variable name', () => {
    for (const ok of ['ANTHROPIC_API_KEY', 'NPM_TOKEN', 'X1']) expect(jobEnvNameProblem(ok)).toBeUndefined();
    for (const bad of ['', 'npm_token', '1X', 'A-B', 'A B', 'A=B', `A${'B'.repeat(200)}`]) expect(jobEnvNameProblem(bad)).toMatch(/is not a variable name/);
  });

  it('the hopper\'s own names are valid, and hold the machine\'s variables and the agent\'s sign-in, never a hopper secret', () => {
    for (const n of JOB_ENV_KEPT) expect(jobEnvNameProblem(n)).toBeUndefined();
    for (const n of ['PATH', 'HOME', 'TERM', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(JOB_ENV_KEPT).toContain(n);
    for (const n of ['HOPPER_DATABASE_URL', 'HOPPER_MASTER_KEY', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN']) expect(JOB_ENV_KEPT).not.toContain(n);
  });
});

describe('a job\'s environment scope (issue #2849 part 5)', () => {
  const settings = { ...NO_JOB_EGRESS, scope: true, keep: ['NPM_TOKEN'], repoKeep: { 'octo/tools': ['STAGING_KEY'] } };

  it('is off when never set', () => {
    expect(NO_JOB_EGRESS).toMatchObject({ scope: false, keep: [], repoKeep: {} });
  });

  it('keeps the hopper\'s names, the user\'s and its repository\'s, matched in any case of the repository', () => {
    const keep = jobEnvKeep(settings, 'Octo/Tools');
    expect(keep).toEqual(expect.arrayContaining(['PATH', 'NPM_TOKEN', 'STAGING_KEY']));
    expect(jobEnvKeep(settings, 'octo/site')).not.toContain('STAGING_KEY');
    expect(jobEnvKeep(settings, undefined)).toContain('NPM_TOKEN');
  });

  it('is kept with the repositories in lowercase, each list without repeats, a repository with no name dropped', () => {
    expect(normalJobEgress({ ...settings, keep: ['NPM_TOKEN', 'NPM_TOKEN'], repoKeep: { 'Octo/Tools': ['A', 'A'], 'octo/site': [] } }))
      .toMatchObject({ scope: true, keep: ['NPM_TOKEN'], repoKeep: { 'octo/tools': ['A'] } });
  });
});
