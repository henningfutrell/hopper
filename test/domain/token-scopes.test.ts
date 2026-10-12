// Token scopes (issue #881, src/domain/token-scopes.ts), pure: the scope each route needs, named from the route; which
// patterns a grant may hold; and that a pattern covers only what it names.
import { describe, expect, it } from 'vitest';
import { scopeAllows, scopeOfRoute, scopeProblem, scopesOfRoutes } from '../../src/domain/token-scopes.ts';

describe('token scopes', () => {
  it('a route needs the scope its area and its act name', () => {
    expect(scopeOfRoute('GET', '/api/jobs/:id')).toBe('jobs:read');
    expect(scopeOfRoute('GET', '/api/queue')).toBe('queue:read');
    expect(scopeOfRoute('POST', '/ui/api/jobs/:id/approve')).toBe('jobs:approve');
    expect(scopeOfRoute('POST', '/ui/api/questions/:id/answer')).toBe('questions:answer');
    expect(scopeOfRoute('POST', '/ui/api/failures/problems/:id/release')).toBe('failures:release');
    expect(scopeOfRoute('POST', '/ui/api/pull-requests/merge')).toBe('pull-requests:merge');
    expect(scopeOfRoute('POST', '/ui/api/vault')).toBe('vault:edit');
    // The API reference's form names the same scope.
    expect(scopeOfRoute('POST', '/ui/api/jobs/{id}/approve')).toBe('jobs:approve');
    expect(scopeOfRoute('POST', '/ui/api/lanes/{machine}')).toBe('lanes:edit');
  });

  it('a route outside the API names no scope', () => {
    expect(scopeOfRoute('GET', '/ui/api/session')).toBeUndefined();
    expect(scopeOfRoute('POST', '/api/jobs')).toBeUndefined();
    expect(scopeOfRoute('POST', '/ui/auth/token/refresh')).toBeUndefined();
    expect(scopeOfRoute('DELETE', '/ui/api/vault')).toBeUndefined();
  });

  it('the scopes of the routes, once each and sorted', () => {
    expect(scopesOfRoutes([{ method: 'post', path: '/ui/api/jobs/:id/approve' }, { method: 'get', path: '/api/jobs' }, { method: 'get', path: '/api/jobs/:id' }]))
      .toEqual(['jobs:approve', 'jobs:read']);
  });

  it('a pattern covers what it names and nothing else', () => {
    expect(scopeAllows(['questions:answer'], 'questions:answer')).toBe(true);
    expect(scopeAllows(['questions:answer'], 'questions:close')).toBe(false);
    expect(scopeAllows(['jobs:*'], 'jobs:approve')).toBe(true);
    expect(scopeAllows(['jobs:*'], 'questions:answer')).toBe(false);
    expect(scopeAllows(['*:read'], 'vault:read')).toBe(true);
    expect(scopeAllows(['*:read'], 'vault:edit')).toBe(false);
    expect(scopeAllows(['*'], 'vault:edit')).toBe(true);
    expect(scopeAllows([], 'jobs:read')).toBe(false);
  });

  it('a pattern must be well formed and name a route', () => {
    const known = ['jobs:approve', 'jobs:read', 'questions:answer'];
    expect(scopeProblem('jobs:approve', known)).toBeUndefined();
    expect(scopeProblem('jobs:*', known)).toBeUndefined();
    expect(scopeProblem('*:read', known)).toBeUndefined();
    expect(scopeProblem('*', known)).toBeUndefined();
    expect(scopeProblem('admin', known)).toMatch(/write <area>:<act>/);
    expect(scopeProblem('jobs:approve; drop', known)).toMatch(/write <area>:<act>/);
    expect(scopeProblem('vault:edit', known)).toMatch(/names no route/);
  });
});
