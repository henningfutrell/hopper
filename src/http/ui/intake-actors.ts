// Settings → Intake (issue #652, design.md "Trusted origin and request cards"): the user's trusted actors — the GitHub
// logins whose issues, labels and assignments start the user's jobs. None named: the connected login only. Access
// (OpenFGA `intake#can_start_jobs`) decides each login, told this list at each check. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IntakeActorSettings } from '../../domain/intake-origin.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** A GitHub user's login: letters, digits and single hyphens; never an app's bot (`name[bot]`). */
const login = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'a GitHub login');
export const intakeActorsBody = z.strictObject({ actors: z.array(login).max(50, 'at most 50 trusted actors') });

const named = (t: Pick<TenantParts, 'store'>): IntakeActorSettings => t.store.settings.getIntakeActors() ?? { actors: [] };

export const INTAKE_ACTORS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/intake-actors', tag: 'Jobs', summary: 'Trusted actors', description: 'Issue #652: the GitHub logins whose issues, labels and assignments start the user\'s jobs. `actors` empty: the connected login only. An open labelled issue assigned to the user is a job only when its author, and whoever labelled and assigned it, is one of them (Access, OpenFGA `intake#can_start_jobs`, decides); any other is a request card in Sources.', returns: '`{ actors: string[] }`' },
  { method: 'post', path: '/ui/api/intake-actors', tag: 'Jobs', summary: 'Set the trusted actors', description: 'The whole list, lowercased (`intake.actors_changed`); empty: the connected login only. An app\'s or a bot\'s login is never one. Applies from the next sync.', role: 'admin', body: intakeActorsBody, returns: '`{ actors: string[] }`', errors: [400] },
];

export function registerIntakeActorRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/intake-actors', async (req) => named(o.tenant(req)));
  app.post('/ui/api/intake-actors', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the trusted actors');
    const t = o.tenant(req);
    const to = [...new Set(parseWith(intakeActorsBody, req.body).actors.map((a) => a.toLowerCase()))].sort();
    t.store.tx(() => {
      const from = named(t).actors;
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setIntakeActors({ actors: to });
      t.store.events.append({ type: 'intake.actors_changed', data: { from, to, by: identityName(s.identity) } });
    });
    return named(t);
  });
}
