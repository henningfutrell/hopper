// Issue #2795: the new-repository policy. A repository a connected account reaches now that it did not reach before is a
// new repository; the policy says, per owner, whether it is added to the job repositories at once (`accept`) or held as a
// new-repository ask for a person (`ask`, the default). The first read only learns what the account reaches.
import { describe, expect, it } from 'vitest';
import { DEFAULT_NEW_REPOSITORY_POLICY, findNewRepositories, modeFor, NO_NEW_REPOSITORIES, type NewRepositoryRecord } from '../../src/domain/new-repositories.ts';

const AT = '2026-10-25T10:00:00.000Z', LATER = '2026-10-25T11:00:00.000Z';
const none = () => false;
const seen = (repos: string[], o: Partial<NewRepositoryRecord> = {}): NewRepositoryRecord => ({ ...NO_NEW_REPOSITORIES, seen: repos, ...o });

describe('the new-repository policy', () => {
  it('asks by default; an owner\'s own mode wins, in any case', () => {
    expect(DEFAULT_NEW_REPOSITORY_POLICY).toEqual({ mode: 'ask', owners: {} });
    const policy = { mode: 'ask' as const, owners: { Acme: 'accept' as const } };
    expect(modeFor(policy, 'acme/api')).toBe('accept');
    expect(modeFor(policy, 'octo/a')).toBe('ask');
    expect(modeFor({ mode: 'accept', owners: { octo: 'ask' } }, 'OCTO/a')).toBe('ask');
  });

  it('the first read only learns what the account reaches: nothing is new', () => {
    const found = findNewRepositories(NO_NEW_REPOSITORIES, ['octo/a', 'octo/b'], [], none, AT);
    expect(found).toEqual({ record: seen(['octo/a', 'octo/b']), accepted: [], asked: [] });
  });

  it('a repository not reached before is asked about; one asked already is not asked again', () => {
    const first = findNewRepositories(seen(['octo/a']), ['octo/a', 'octo/b'], [], none, AT);
    expect(first.asked).toEqual(['octo/b']);
    expect(first.accepted).toEqual([]);
    expect(first.record.asks).toEqual([{ repository: 'octo/b', at: AT }]);
    const again = findNewRepositories(first.record, ['octo/a', 'octo/b'], [], none, LATER);
    expect(again.asked).toEqual([]);
    expect(again.record.asks).toEqual([{ repository: 'octo/b', at: AT }]);
  });

  it('accept adds it at once; a waiting ask of an owner switched to accept is added too', () => {
    const asked = findNewRepositories(seen(['acme/api']), ['acme/api', 'acme/web'], [], none, AT).record;
    const accepting = { ...asked, policy: { mode: 'ask' as const, owners: { acme: 'accept' as const } } };
    const found = findNewRepositories(accepting, ['acme/api', 'acme/web', 'acme/docs'], [], none, LATER);
    expect(found.accepted).toEqual(['acme/web', 'acme/docs']);
    expect(found.asked).toEqual([]);
    expect(found.record.asks).toEqual([]);
  });

  it('never asks about a job repository, one another account has, or one gone; drops such asks', () => {
    const r = seen(['octo/a'], { asks: [{ repository: 'octo/gone', at: AT }, { repository: 'octo/chosen', at: AT }] });
    const found = findNewRepositories(r, ['octo/a', 'octo/chosen', 'octo/other', 'octo/new'], ['Octo/Chosen'], (x) => x === 'octo/other', LATER);
    expect(found.asked).toEqual(['octo/new']);
    expect(found.record.asks).toEqual([{ repository: 'octo/new', at: LATER }]);
  });

  it('a dismissed repository stays seen, so it is not asked about again', () => {
    const asked = findNewRepositories(seen(['octo/a']), ['octo/a', 'octo/b'], [], none, AT).record;
    const dismissed = { ...asked, asks: [] };
    expect(findNewRepositories(dismissed, ['octo/a', 'octo/b'], [], none, LATER).asked).toEqual([]);
  });
});
