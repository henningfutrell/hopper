// Grant limits (issue #892, design.md "Grant limits"): beside its scopes, a grant may name the repositories and the job
// sources its tokens act on. A limited grant's act names what it acts on (its targets); each target must be in every
// list the grant names. An act that names no target is refused: deny by default, as for scopes.
import { describe, expect, it } from 'vitest';
import { GRANT_LIMITS_MAX, limitRefusal, limitsProblem, normalLimits, repoOfItemKey } from '../../src/domain/grant-limits.ts';

describe('grant limits', () => {
  it('are kept in one form: repositories lower case, each list sorted and once; none at all is no limit', () => {
    expect(normalLimits({ repos: ['Acme/App', 'acme/app', 'acme/api'], sources: ['github', 'github'] })).toEqual({ repos: ['acme/api', 'acme/app'], sources: ['github'] });
    expect(normalLimits({ repos: [], sources: [] })).toBeUndefined();
    expect(normalLimits({})).toBeUndefined();
    expect(normalLimits({ sources: ['direct'] })).toEqual({ sources: ['direct'] });
  });

  it('a repository is owner/name, a source a name; each list has a bound', () => {
    expect(limitsProblem({ repos: ['acme/app'], sources: ['github'] })).toBeUndefined();
    expect(limitsProblem({ repos: ['acme'] })).toMatch(/owner\/name/);
    expect(limitsProblem({ repos: ['acme/app/x'] })).toMatch(/owner\/name/);
    expect(limitsProblem({ sources: [''] })).toMatch(/source/);
    expect(limitsProblem({ sources: ['has space'] })).toMatch(/source/);
    expect(limitsProblem({ repos: Array.from({ length: GRANT_LIMITS_MAX + 1 }, (_, i) => `acme/r${i}`) })).toMatch(String(GRANT_LIMITS_MAX));
  });

  it('a target in every list the grant names passes; any other is refused, and the refusal says why', () => {
    const l = { repos: ['acme/app'], sources: ['github'] };
    expect(limitRefusal(l, [{ repo: 'Acme/App', source: 'github' }])).toBeUndefined();
    expect(limitRefusal(l, [{ repo: 'acme/other', source: 'github' }])).toMatch(/acme\/other.*acme\/app|acme\/app.*acme\/other/);
    expect(limitRefusal(l, [{ repo: 'acme/app', source: 'direct' }])).toMatch(/direct/);
    expect(limitRefusal(l, [{ source: 'github' }])).toMatch(/no repository/);
    expect(limitRefusal({ repos: ['acme/app'] }, [{ repo: 'acme/app' }])).toBeUndefined();
    expect(limitRefusal({ sources: ['github'] }, [{ repo: 'acme/app' }])).toMatch(/no job source/);
    // Every target must pass.
    expect(limitRefusal({ repos: ['acme/app'] }, [{ repo: 'acme/app' }, { repo: 'acme/api' }])).toMatch(/acme\/api/);
    // No target at all: the act names nothing the limits can place.
    expect(limitRefusal({ repos: ['acme/app'] }, [])).toMatch(/names no repository/);
  });

  it('an item key that is a GitHub issue or pull request URL names its repository', () => {
    expect(repoOfItemKey('https://github.com/Acme/App/issues/12')).toBe('acme/app');
    expect(repoOfItemKey('https://github.com/acme/app/pull/3')).toBe('acme/app');
    expect(repoOfItemKey('manual-1')).toBeUndefined();
    expect(repoOfItemKey('https://example.com/acme/app/issues/1')).toBeUndefined();
  });
});
