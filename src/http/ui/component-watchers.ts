// Component watchers (issue #1077, design.md "Component watchers"): each watcher with its last check and the drift it
// found, and the setting whether a drift files a drift issue. The setting is the user's, in the database, changed by an
// admin; it applies at the next check.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const componentWatchersBody = z.strictObject({ fileIssues: z.boolean() });

export const COMPONENT_WATCHER_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/component-watchers', tag: 'State', summary: 'Component watchers', description: 'Issue #1077: whether a drift files a drift issue (`settings.fileIssues`, default false), and each component watcher — `name`, the `component` it checks against which source of `truth`, `intervalSeconds`, its last check (`checkedAt`, `error` when it failed, `issueError` when its drift issue could not be written) and the drift it found now: per `kind`, how many `items` and each (`list`: its `key`, what the component `says` and what its source of `truth` says, `since` when), `since` when, and its drift `issue`. Not cached.', returns: '`ComponentWatchersView`' },
  { method: 'post', path: '/ui/api/component-watchers', tag: 'State', summary: 'Change whether drift files an issue', description: 'Issue #1077: `fileIssues`. On, each kind of drift is one drift issue on the hopper\'s own repository, filed and updated with your own GitHub connection. Saved for the user (`component_watchers.settings_changed`); applies at the next check. The same value changes nothing.', role: 'admin', body: componentWatchersBody, returns: '`ComponentWatchersView`', errors: [400] },
];

export function componentWatcherReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/component-watchers', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).githubProxy.componentWatchers.view();
  });
}

export function registerComponentWatcherRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/component-watchers', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the component watchers');
    const b = parseWith(componentWatchersBody, req.body);
    return o.tenant(req).githubProxy.componentWatchers.change(b, identityName(s.identity));
  });
}
