// The GitHub App's private key (issue #1243, design.md "The GitHub App's private key in the vault"): GET /api/github-app-key
// shows whether one is kept, never the key; POST /ui/api/github-app-key sets it — checked to be a private key, then kept in
// the vault's system scope — or removes it. The write-only field on the app source's setup card posts here. The user's own
// or an admin's (least role operator, then Access decides); answered as its view, never the key, not cached. GET
// /api/github-apps lists the GitHub Apps installed on the organizations the person's GitHub connection knows, for the card's
// pick (design.md "Pick an installed GitHub App"): read from GitHub at each ask, not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VAULT_VALUE_MAX } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import type { Operation } from '../openapi-operation.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const githubAppKeyBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), value: z.string().max(VAULT_VALUE_MAX) }),
  z.strictObject({ action: z.literal('remove') }),
]);
/** The API reference's operations of these routes (src/http/openapi.ts). */
export const GITHUB_APP_KEY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/github-app-key', tag: 'Jobs', summary: 'Whether the GitHub App\'s private key is kept', description: 'Issue #1243. The GitHub App source\'s private key, kept in the vault\'s system scope: `set`, `setAt` and `setBy`, never the key; `environment.variable` while the runtime still gives the variable it was imported from once (the hopper does not read it again); `problem` when none can be kept or opened. Not cached.', returns: '`GitHubAppKeyView`' },
  { method: 'post', path: '/ui/api/github-app-key', tag: 'Jobs', summary: 'Set or remove the GitHub App\'s private key', description: 'Issue #1243: the write-only field on the app source\'s setup card in Sources. `set` checks that `value` is a private key in PEM form (real line breaks or `\\n` escapes), then keeps it in the vault\'s system scope, sealed under `HOPPER_MASTER_KEY`, in place of any key kept (`vault.secret_set`, name `system/github-app-private-key`); a value that is not a key is not kept, and the 400 does not carry it. `remove` deletes it (`vault.secret_removed`); 404 when none is set. The app source uses the change at its next sync, without a restart. The user\'s own key: Access (OpenFGA, `system_secret#can_change`) allows the user or an admin; 403 when it does not. 503 when Access cannot be asked, or the runtime gives no `HOPPER_MASTER_KEY`. The answer is the key\'s view (`GitHubAppKeyView`), never the key. Not cached.', role: 'operator', body: githubAppKeyBody, returns: '`GitHubAppKeyView`', errors: [400, 403, 404, 503] },
  { method: 'get', path: '/api/github-apps', tag: 'Jobs', summary: 'The GitHub Apps installed on your organizations', description: 'Issue #1243: what the app source\'s setup card in Sources offers to pick. With the person\'s own GitHub connection, `GET /orgs/{org}/installations` for each organization it knows: those the hopper\'s app is installed on, as last read, and the owners of the job repositories, not the account\'s own login. `apps`: each app\'s organization, `appId`, `slug` and `settingsUrl`; `refused`: an organization GitHub would not list (only an owner may, and the hopper\'s app needs the organization\'s Administration permission, read), with why; `notConnected` when no GitHub account is connected (nothing is asked). Use this app sets `appId` and `slug` on the source through `POST /ui/api/plugins`. Read from GitHub at each ask; not cached.', returns: '`InstalledAppsView`' },
];

const KEY_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

export function registerGitHubAppKeyRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/github-app-key', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).githubAppKey.view();
  });
  app.get('/api/github-apps', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).installedApps.list();
  });
  app.post('/ui/api/github-app-key', o.operator, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, "sign in to change the GitHub App's private key");
    const { githubAppKey } = o.tenant(req);
    const edit = parseWith(githubAppKeyBody, req.body);
    const who = { userId: s.userId, admin: s.role === 'admin', by: identityName(s.identity) };
    const r = edit.action === 'set' ? await githubAppKey.set(edit.value, who) : await githubAppKey.remove(who);
    if (!r.ok) throw new HttpError(KEY_STATUS[r.code], r.error);
    return r.view;
  });
}
