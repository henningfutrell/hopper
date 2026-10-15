// Issue #1351: GitHub refuses a GitHub App's token with "Resource not accessible by integration" and names neither the
// permission nor the install it lacks. The hopper adds both: the permission GitHub asks for (REST's
// x-accepted-github-permissions header, or the GraphQL field it refused) and the fix.
import { describe, expect, it } from 'vitest';
import { explained, permissionsOfHeader, permissionsOfPath } from '../../src/sources/github/app/refusal.ts';
import { toApiError } from '../../src/sources/github/app/http.ts';
import { accountError } from '../../src/sources/github/account/api.ts';

const REFUSED = 'Resource not accessible by integration';
const refusal = (header?: string) => Object.assign(new Error(REFUSED), { status: 403, response: { headers: header ? { 'x-accepted-github-permissions': header } : {} } });

describe('the permission GitHub asks for', () => {
  it('from the header: each set in plain words, a set needs all, any one set will do', () => {
    expect(permissionsOfHeader('pull_requests=read')).toBe('Pull requests (read)');
    expect(permissionsOfHeader('checks=read,statuses=read')).toBe('Checks (read) and Commit statuses (read)');
    expect(permissionsOfHeader('contents=read; pull_requests=write')).toBe('Contents (read) or Pull requests (write)');
    expect(permissionsOfHeader('some_new_thing=read')).toBe('some_new_thing (read)');
    expect(permissionsOfHeader('')).toBeUndefined();
    expect(permissionsOfHeader(undefined)).toBeUndefined();
  });

  it('from a GraphQL path: the field refused, nearest the end', () => {
    expect(permissionsOfPath(['repository', 'pullRequests', 'nodes', 0, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'])).toBe('Checks (read) and Commit statuses (read)');
    expect(permissionsOfPath(['repository', 'pullRequests'])).toBe('Pull requests (read)');
    expect(permissionsOfPath(['organization', 'projectV2'])).toBe('Projects (read)');
    expect(permissionsOfPath(['viewer'])).toBeUndefined();
    expect(permissionsOfPath(undefined)).toBeUndefined();
  });
});

describe('a refusal explained', () => {
  it('names the permission and the fix: install on the owner with the repository, accept new permissions', () => {
    const m = explained(REFUSED, 'Pull requests (read)');
    expect(m).toContain(REFUSED);
    expect(m).toContain('the GitHub App needs Pull requests (read)');
    expect(m).toMatch(/install it on the repository's owner with this repository/);
    expect(m).toMatch(/accept its new permissions/);
  });

  it('no permission known: still says what to do', () => {
    expect(explained(REFUSED, undefined)).toMatch(/the GitHub App lacks a permission .* or is not installed/);
  });

  it('with the app\'s install link: the fix names where to install it', () => {
    const m = explained(REFUSED, 'Pull requests (read)', 'https://github.com/apps/some-app/installations/new');
    expect(m).toMatch(/install it on the repository's owner with this repository at https:\/\/github\.com\/apps\/some-app\/installations\/new/);
    expect(m).toMatch(/accept its new permissions/);
  });

  it('any other message is left as it is', () => {
    expect(explained('Not Found', 'Issues (read)')).toBe('Not Found');
  });

  it('the App adapter and the connected account explain a 403 refusal, and keep it permanent', () => {
    const app = toApiError(refusal('checks=read'), 'checks of owner/repo@abc');
    expect(app).toMatchObject({ status: 403, permanent: true });
    expect(app.message).toMatch(/^checks of owner\/repo@abc: Resource not accessible by integration \(the GitHub App needs Checks \(read\)/);
    const account = accountError(refusal('pull_requests=read'), 'open pull requests of owner/repo');
    expect(account).toMatchObject({ status: 403, permanent: true });
    expect(account.message).toContain('the GitHub App needs Pull requests (read)');
  });

  it('the App adapter and the connected account give the install link they are given', () => {
    const link = 'https://github.com/apps/some-app/installations/new';
    expect(toApiError(refusal('checks=read'), 'checks of owner/repo@abc', link).message).toContain(`with this repository at ${link}`);
    expect(accountError(refusal('pull_requests=read'), 'open pull requests of owner/repo', link).message).toContain(`with this repository at ${link}`);
  });
});
