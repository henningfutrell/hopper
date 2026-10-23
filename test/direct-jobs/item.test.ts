// Issue #901: a direct job as its source's item. The job is told first that its brief and results are private, then its
// brief, then the context: its labels, what the submitter authorized, who submitted it, and the one repository a pull
// request may go to — or none.
import { describe, expect, it } from 'vitest';
import type { DirectJob } from '../../src/domain/direct-jobs.ts';
import { directItem, PRIVATE_LINE } from '../../src/direct-jobs/index.ts';

const job: DirectJob = {
  id: 'd1', title: 'Unlock a sign-in', brief: 'Clear the lockout.', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'],
  submittedBy: { person: 'Ops', via: 'api' }, submittedAt: '2026-10-12T10:00:00.000Z',
};

describe('a direct job as an item (issue #901)', () => {
  it('runs the brief after the private line, with the context and the defaults', () => {
    const item = directItem(job, 'http://hopper.invalid/#direct-job-d1');
    const lines = item.prompt.split('\n');
    expect(lines.slice(0, 3)).toEqual([PRIVATE_LINE, '', 'Clear the lockout.']);
    expect(item.prompt).toContain('routing labels: sme:identity');
    expect(item.prompt).toContain('authorized by the submitter: keycloak:otp-reset.');
    expect(item.prompt).toContain('repository: none — open no pull request');
    expect(item).toMatchObject({
      key: 'direct:d1', title: 'Unlock a sign-in', body: 'Clear the lockout.', author: 'Ops', labels: ['sme:identity'],
      executor: 'herdr-claude', priority: 50, priorityReason: 'default', origin: 'trusted', env: { HOPPER_DIRECT_JOB: 'd1' },
    });
    expect(item.repo).toBeUndefined();
  });

  it('names the repository a pull request may go to, and takes the executor and priority given', () => {
    const item = directItem({ ...job, repo: 'octo-org/hello', executor: 'claude', priority: 80, authorizations: [] }, 'u');
    expect(item.prompt).toContain('repository: octo-org/hello');
    expect(item.prompt).toContain('authorized by the submitter: none.');
    expect(item).toMatchObject({ repo: 'octo-org/hello', executor: 'claude', priority: 80, priorityReason: 'submitted', env: { HOPPER_DIRECT_JOB: 'd1', HOPPER_REPO: 'octo-org/hello' } });
  });

  it('names the submitter to the job without an email address (issue #1380)', () => {
    const item = directItem({ ...job, submittedBy: { person: 'ada@example.com', via: 'ui' } }, 'u');
    expect(item.prompt).toContain('submitted by: ada (ui)');
    expect(item.prompt).not.toContain('ada@example.com');
    expect(item.author).toBe('ada@example.com');
  });

  it('names its own push requirements, and none when it has none (issue #2555 part 3)', () => {
    expect(directItem(job, 'u').prompt).not.toContain('push requirements');
    const item = directItem({ ...job, pushRequirements: [{ id: 'kotlin-coverage', checks: [{ name: 'coverage', run: './gradlew koverVerify' }] }] }, 'u');
    expect(item.prompt).toContain('push requirements: the submitter set kotlin-coverage. Before each push, run sh "$HOPPER_REQUIREMENTS" check');
  });
});
