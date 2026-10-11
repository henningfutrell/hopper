// Issue #677: what makes a repository one with no checks, pure — a workflow file's triggers, the state from what was
// found, and the recommended job's text.
import { describe, expect, it } from 'vitest';
import { addChecksJob, repoChecksState, runsOnPullRequests } from '../../src/domain/types.ts';

describe('runsOnPullRequests', () => {
  it.each([
    ['on: pull_request', true],
    ['on: pull_request_target', true],
    ['on: [push, pull_request]', true],
    ['on:\n  pull_request:\n    branches: [main]', true],
    ['on:\n  push:\n  pull_request_target:\n', true],
    ['on: push', false],
    ['on: [push, workflow_dispatch]', false],
    ['on:\n  schedule:\n    - cron: "0 0 * * *"\n# pull_request is not here', false],
    ['name: no trigger', false],
    ['on: [unclosed', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(runsOnPullRequests(text)).toBe(expected);
  });
});

describe('repoChecksState', () => {
  const none = { required: [], workflows: [], pullRequests: { read: 3, withChecks: 0 } };
  it('no checks only when nothing of the three is found', () => {
    expect(repoChecksState(none)).toBe('no checks');
    expect(repoChecksState({ ...none, required: ['test'] })).toBe('checks');
    expect(repoChecksState({ ...none, workflows: ['ci.yml'] })).toBe('checks');
    expect(repoChecksState({ ...none, pullRequests: { read: 3, withChecks: 1 } })).toBe('checks');
  });
  it('a repository with no pull request yet and nothing else has no checks', () => {
    expect(repoChecksState({ ...none, pullRequests: { read: 0, withChecks: 0 } })).toBe('no checks');
  });
});

describe('addChecksJob', () => {
  it('names the repository and asks for the checks, and the required status checks where the token allows', () => {
    const job = addChecksJob('Octo/Bare');
    expect(job.title).toBe('Add PR checks to Octo/Bare');
    expect(job.body).toMatch(/stack/);
    expect(job.body).toMatch(/typecheck, the lint, the tests and the build/);
    expect(job.body).toMatch(/required status checks/);
    expect(job.body).toMatch(/If the token cannot/);
  });
});
