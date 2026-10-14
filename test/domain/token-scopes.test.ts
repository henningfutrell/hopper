// Token scopes (issue #881, src/domain/token-scopes.ts), pure: the scope each route needs, named from the route; which
// patterns a grant may hold; and that a pattern covers only what it names. A route's actions' scopes (issue #909).
import { describe, expect, it } from 'vitest';
import { scopeAllows, scopeAllowsSome, scopeOfAction, scopeOfRoute, scopeProblem, scopesOfRoutes } from '../../src/domain/token-scopes.ts';

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

  it('an action of a route has a scope of its own, which the route\'s scope covers (issue #909)', () => {
    expect(scopeOfAction('vault:edit', 'approve-template')).toBe('vault:edit.approve-template');
    expect(scopeOfAction('failures:resolve', 'done_by_hand')).toBe('failures:resolve.done-by-hand');
    expect(scopeAllows(['vault:edit'], 'vault:edit.approve-template')).toBe(true);
    expect(scopeAllows(['vault:*'], 'vault:edit.approve-template')).toBe(true);
    expect(scopeAllows(['*'], 'vault:edit.approve-template')).toBe(true);
    expect(scopeAllows(['vault:edit.approve-template'], 'vault:edit.approve-template')).toBe(true);
    expect(scopeAllows(['vault:edit.approve-template'], 'vault:edit.set')).toBe(false);
    expect(scopeAllows(['vault:edit.approve-template'], 'vault:edit')).toBe(false);
    expect(scopeAllows(['vault:ed'], 'vault:edit.set')).toBe(false);
    expect(scopeAllows(['*:read'], 'vault:edit.set')).toBe(false);
  });

  it('the door lets through a grant that holds the route\'s scope or one of its actions\' (issue #909)', () => {
    expect(scopeAllowsSome(['vault:edit.approve-template'], 'vault:edit')).toBe(true);
    expect(scopeAllowsSome(['vault:edit'], 'vault:edit')).toBe(true);
    expect(scopeAllowsSome(['vault:edit.approve-template'], 'vault:read')).toBe(false);
    expect(scopeAllowsSome(['sources:intake.approve'], 'vault:edit')).toBe(false);
    expect(scopeAllowsSome(['*:read'], 'vault:edit')).toBe(false);
  });

  it('an action\'s scope is a pattern a grant may hold, when a route has it (issue #909)', () => {
    const known = ['vault:edit', 'vault:edit.approve-template', 'vault:edit.set'];
    expect(scopeProblem('vault:edit.approve-template', known)).toBeUndefined();
    expect(scopeProblem('vault:edit.nope', known)).toMatch(/names no route/);
    expect(scopeProblem('vault:edit.a.b', known)).toMatch(/write <area>:<act>/);
  });
});
