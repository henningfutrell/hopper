// Settings → Search (issue #2990, design.md "Search with a managed Solr"), the hopper's admin's: GET /api/solr-credentials
// shows which Solr search uses, where the credentials it sends come from, and whether the instance's vault keeps a pair —
// never the username or the password; POST /ui/api/solr-credentials sets the pair, checked once against Solr, or removes
// it. `hopper solr-credentials` reads and posts here. Not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SolrCredentialsView } from '../../domain/search.ts';
import { VAULT_VALUE_MAX } from '../../domain/vault.ts';
import type { SolrCredentialsAdmin } from '../../search/solr-credentials.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const solrCredentialsBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('set'), username: z.string().max(200), password: z.string().max(VAULT_VALUE_MAX - 300) }),
  z.strictObject({ action: z.literal('remove') }),
]);
const STATUS = { invalid: 400, not_found: 404, conflict: 409, unavailable: 503 } as const;

const VIEW = '`configured`: whether `HOPPER_SOLR_URL` is set; `url`: the core or collection, with no userinfo; `source`: where the credentials the hopper sends come from now — `url` (its userinfo) or `runtime` (`HOPPER_SOLR_USERNAME` and `HOPPER_SOLR_PASSWORD`), which win, `vault`, or `none` —; `kept`: whether the instance\'s vault keeps a pair, who set it and when, never the username or the password; `problem`: why none can be kept or opened now.';

export const SOLR_CREDENTIALS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/solr-credentials', tag: 'Jobs', summary: 'Search: the Solr credentials', description: `Only the instance admin (issue #2990). ${VIEW} Not cached.`, returns: '`SolrCredentialsView`', errors: [403] },
  { method: 'post', path: '/ui/api/solr-credentials', tag: 'Jobs', summary: 'Search: set or remove the Solr credentials kept in the vault', description: `Only the instance admin (issue #2990). \`set\`: checks \`username\` and \`password\` once against Solr (one count on the core or collection, with basic auth), then keeps them in the instance's vault as the system secret \`solr-credentials\`, sealed under \`HOPPER_MASTER_KEY\` (\`vault.secret_set\`), with no last 4 characters; search sends them from the next call. A pair Solr refuses, or a check that cannot reach it, is not kept: 400, with no credential in the error. 409 when \`HOPPER_SOLR_URL\` is not set, or the URL or the runtime gives the credentials (they win). \`remove\`: deletes them (\`vault.secret_removed\`); 404 when none are kept. 503 without a master key. ${VIEW} \`hopper solr-credentials set|remove\` posts here.`, role: 'admin', body: solrCredentialsBody, returns: '`SolrCredentialsView`', errors: [400, 403, 404, 409, 503] },
];

export function registerSolrCredentialsRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; solrCredentials: SolrCredentialsAdmin; by: (req: FastifyRequest) => string }): void {
  app.get('/api/solr-credentials', async (req, reply): Promise<SolrCredentialsView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the Solr credentials');
    reply.header('cache-control', 'no-store');
    return o.solrCredentials.view();
  });
  app.post('/ui/api/solr-credentials', o.instance, async (req, reply): Promise<SolrCredentialsView> => {
    reply.header('cache-control', 'no-store');
    const r = await o.solrCredentials.change(parseWith(solrCredentialsBody, req.body), o.by(req));
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return r.view;
  });
}
