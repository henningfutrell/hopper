// A mint test (issue #781, design.md "Minting: short-lived credentials"), an admin's: the vault mints an AWS read session
// for an `aws-role/<account>/<role>` from the minting credential for that account, and asks STS who the session is; or
// (issue #854) a read token for a `cluster/<name>`, and asks the cluster who it is and which namespaces it lists. The
// answer is never a key or a token, and is not cached.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const mintTestBody = z.strictObject({ asset: z.string().max(220) });

const STATUS = { invalid: 400, not_found: 404, failed: 422 } as const;

export const MINT_TEST_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/vault/mint-test', tag: 'Vault', summary: 'Test a minting credential', description: 'Issues #781, #854. `asset` is `aws-role/<account>/<role>` or `cluster/<name>`. For an `aws-role` (`kind` `aws`): The vault mints a read session from the minting credential for that account, as it mints one for a job (900 s, the `ReadOnlyAccess` session policy and the deny policy of issue #715, the session name the credential gives: `SessionName`, else `SessionNamePrefix` or `hopper-`, then `mint-test`), and asks STS `GetCallerIdentity` with it. Answers the role, the session name, the expiry and `identity` (`arn`, `account`, `userId`) as STS said it; never a key. For a `cluster` (`kind` `kube`): the vault mints a read token from the cluster\'s minting credential, as for a job — a TokenRequest token, or an EKS token signed with a read session of the credential\'s role (EKS sign-in) —, and asks the cluster who the token is (a SelfSubjectReview, `kubectl auth whoami`) and which namespaces it lists (`kubectl get ns`). Answers the API server, the expiry, `user` (`username`, `groups`) and `namespaces`, and for EKS sign-in `roleArn` and `sessionName`; never the token. 400: neither an `aws-role` nor a `cluster`, or several minting credentials mint for the account or the cluster (issue #1761; the reason names them all, and the vault picks none). 404: no minting credential mints for the account or the cluster. 422: STS or the cluster refused, with its reason and the minting credential the test used. Each test is a `vault.mint_tested` event. Not cached.', role: 'admin', body: mintTestBody, returns: 'the mint test: kind (aws or kube), asset, credential, expiresAt; for aws roleArn, sessionName, durationSeconds, policyArns, identity; for kube server, user, namespaces and, for EKS sign-in, roleArn and sessionName', errors: [400, 404, 422] },
];

export function registerMintTestRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/vault/mint-test', o.admin, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to test a minting credential');
    const { asset } = parseWith(mintTestBody, req.body);
    const r = await o.tenant(req).vault.testMint(asset.trim(), personOf(s));
    if ('refused' in r) throw new HttpError(STATUS[r.code], r.refused);
    return r.tested;
  });
}
