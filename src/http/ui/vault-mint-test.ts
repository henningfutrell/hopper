// A mint test (issue #781, design.md "Minting: short-lived credentials"), an admin's: the vault mints an AWS read session
// for an `aws-role/<account>/<role>` from the minting credential for that account, and asks STS who the session is. The
// answer is the assumed role and the session name, never a key, and is not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const mintTestBody = z.strictObject({ asset: z.string().max(220) });

const STATUS = { invalid: 400, not_found: 404, failed: 422 } as const;

export const MINT_TEST_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/vault/mint-test', tag: 'Vault', summary: 'Test an AWS minting credential', description: 'Issue #781. `asset` is `aws-role/<account>/<role>`. The vault mints a read session from the minting credential for that account, as it mints one for a job (900 s, the `ReadOnlyAccess` session policy, the session name the credential gives: `SessionName`, else `SessionNamePrefix` or `hopper-`, then `mint-test`), and asks STS `GetCallerIdentity` with it. Answers the role, the session name, the expiry and `identity` (`arn`, `account`, `userId`) as STS said it; never a key. 400: not an `aws-role`. 404: no minting credential mints for the account. 422: STS refused, with its reason. Each test is a `vault.mint_tested` event. Not cached.', role: 'admin', body: mintTestBody, returns: 'the mint test: asset, credential, roleArn, sessionName, durationSeconds, policyArns, expiresAt, identity', errors: [400, 404, 422] },
];

export function registerMintTestRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/vault/mint-test', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to test a minting credential');
    const { asset } = parseWith(mintTestBody, req.body);
    const r = await o.tenant(req).vault.testMint(asset.trim(), identityName(s.identity));
    if ('refused' in r) throw new HttpError(STATUS[r.code], r.refused);
    return r.tested;
  });
}
