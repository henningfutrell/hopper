// Settings → Intake (issue #652, design.md "Trusted origin and request cards"): the user's trusted actors — the GitHub
// accounts whose issues, labels and assignments start the user's jobs. None named: the connected login only. Access
// (OpenFGA `intake#can_start_jobs`) decides each login, told this list at each check. Least role to change: admin.
// Issue #930: picked from real accounts — the candidates and a lookup by login, read with the user's own GitHub
// connection — and kept by GitHub user id, each id read from GitHub before it is saved, so no login that does not exist
// is ever kept. The same reads and the save are the API's, so an agent picks as a person does.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GitHubAccount, IntakeActorSettings } from '../../domain/intake-origin.ts';
import { actorCandidates, ActorsGitHubError, IntakeActorsRefused, resolveActors, type ActorsGitHub } from '../../intake-actors/index.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts, type Tenants } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** A GitHub user's login: letters, digits and single hyphens. */
const login = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'a GitHub login');
export const intakeActorsBody = z.strictObject({ ids: z.array(z.number().int().positive()).max(50, 'at most 50 trusted actors') });
export const intakeActorLookupQuery = z.strictObject({ login });

/** Settings → Intake as read: the accounts named by id, the logins named before ids (to pick again), and the connected login. */
export interface IntakeActorsView {
  accounts: GitHubAccount[];
  /** Logins kept before issue #930, with no id: they count by login until the list is saved again. */
  unresolved: string[];
  /** The connected login, the one trusted actor while none is named; null: no GitHub connected. */
  connected: string | null;
}

const named = (t: Pick<TenantParts, 'store'>): IntakeActorSettings => t.store.settings.getIntakeActors() ?? { actors: [] };

function viewOf(t: Pick<TenantParts, 'store' | 'githubProxy'>): IntakeActorsView {
  const s = named(t);
  return { accounts: s.accounts ?? [], unresolved: s.accounts ? [] : s.actors, connected: t.githubProxy.connection.login() ?? null };
}

export const INTAKE_ACTORS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/intake-actors', tag: 'Jobs', summary: 'Trusted actors', description: 'Issues #652, #930: the GitHub accounts whose issues, labels and assignments start the user\'s jobs, kept by GitHub user id, each with its login, type and avatar as GitHub last answered them. `accounts` empty: the connected login only (`connected`). `unresolved`: logins kept before ids, which count by login until the list is saved again. An open labelled issue assigned to the user is a job only when its author, and whoever labelled and assigned it, is one of them (Access, OpenFGA `intake#can_start_jobs`, decides); any other is a request card in Intake.', returns: '`IntakeActorsView`' },
  { method: 'get', path: '/api/intake-actors/candidates', tag: 'Jobs', summary: 'Accounts to trust', description: 'Issue #930: the GitHub accounts the picker offers, read now with the user\'s own GitHub connection: the connected account, the job repositories\' collaborators (shown only to who can push), their organizations\' members, the authors of their newest issues, and the hopper\'s users and API token holders by their connected GitHub. Each with `id`, `login`, `type`, `avatarUrl` and `from`, where it was found. Only a person\'s account: no app, bot or organization. `problems`: what could not be read. 503: no GitHub connection.', returns: '`{ candidates: ActorCandidate[], problems: string[] }`', errors: [503] },
  { method: 'get', path: '/api/intake-actors/lookup', tag: 'Jobs', summary: 'Look up an account to trust', description: 'Issue #930: the GitHub account with this login, read now with the user\'s own GitHub connection. 404: GitHub knows none; 503: no GitHub connection.', query: intakeActorLookupQuery, returns: '`GitHubAccount`', errors: [400, 404, 502, 503] },
  { method: 'post', path: '/ui/api/intake-actors', tag: 'Jobs', summary: 'Set the trusted actors', description: 'Issue #930: the whole list, by GitHub user id. Each id is read from GitHub first, with the user\'s own connection: an id GitHub does not know, or an app\'s, a bot\'s or an organization\'s account, is refused (400) and nothing changes. Kept with each account\'s login, type and avatar; `intake.actors_changed` names the logins. Empty: the connected login only. Applies from the next sync.', role: 'admin', body: intakeActorsBody, returns: '`IntakeActorsView`', errors: [400, 502, 503] },
];

/** The user's own GitHub for the picker, or 503 when none is connected. */
function githubOf(t: TenantParts): { api: ActorsGitHub; login: string } {
  const g = t.githubProxy.actors();
  if ('problem' in g) throw new HttpError(503, g.problem);
  return g;
}

/** `fn`'s answer; a refusal as its status, GitHub's failure as 502. */
const answer = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IntakeActorsRefused) throw new HttpError(e.status, e.message);
    if (e instanceof ActorsGitHubError) throw new HttpError(502, e.message);
    throw e;
  }
};

export function registerIntakeActorRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; tenants: Tenants;
  /** Whether a user holds a live API token (a grant, issue #881). */
  grants: { list(userId: string): unknown[] };
}): void {
  app.get('/api/intake-actors', async (req) => viewOf(o.tenant(req)));
  app.get('/api/intake-actors/candidates', async (req) => {
    const t = o.tenant(req);
    const g = githubOf(t);
    const hopperUsers = o.tenants.list().flatMap((u) => {
      const l = o.tenants.user(u.id)?.githubProxy.connection.login();
      return l ? [{ login: l, apiToken: o.grants.list(u.id).length > 0 }] : [];
    });
    return answer(() => actorCandidates({ github: g.api, repos: t.githubProxy.connection.jobRepositories(), connected: g.login, hopperUsers }));
  });
  app.get('/api/intake-actors/lookup', async (req) => {
    const { login: wanted } = parseWith(intakeActorLookupQuery, req.query);
    const a = await answer(() => githubOf(o.tenant(req)).api.byLogin(wanted));
    if (!a) throw new HttpError(404, `GitHub knows no account ${wanted}`);
    return a;
  });
  app.post('/ui/api/intake-actors', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the trusted actors');
    const t = o.tenant(req);
    const { ids } = parseWith(intakeActorsBody, req.body);
    const accounts = ids.length === 0 ? [] : await answer(() => resolveActors(githubOf(t).api, ids));
    const to = accounts.map((a) => a.login.toLowerCase());
    t.store.tx(() => {
      const before = named(t);
      if (JSON.stringify(before.accounts ?? null) === JSON.stringify(accounts) && before.actors.length === to.length) return;
      t.store.settings.setIntakeActors({ actors: to, accounts });
      if (JSON.stringify(before.actors) !== JSON.stringify(to)) t.store.events.append({ type: 'intake.actors_changed', data: { from: before.actors, to, by: identityName(s.identity) } });
    });
    return viewOf(t);
  });
}
