// The credential check's routes (issues #1459, #1467): an admin acknowledges a machine whose job user holds infra
// credentials (Use anyway, or Acknowledge: it takes jobs, its warning folds), stops it (it takes no job), or turns strict
// mode on (every such machine no admin acknowledged takes no job). Each is a box action (src/http/ui/box-actions.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, userIdOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const acceptBody = z.strictObject({
  machineKey: z.string().min(1),
  credentials: z.array(z.string()),
});

export const revokeBody = z.strictObject({
  machineKey: z.string().min(1),
});

export const credentialCheckBody = z.strictObject({ strict: z.boolean() });

export function registerMachineCredentialRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock;
}): void {
  app.post('/ui/api/machines/:id/credentials/accept', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to accept machine credentials');
    const body = parseWith(acceptBody, req.body ?? {});
    const { store } = o.tenant(req);
    store.credentialAcceptances.accept(body.machineKey, body.credentials, id, o.clock.now().toISOString());
    return { ok: true };
  });

  app.post('/ui/api/machines/:id/credentials/revoke', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to stop a machine');
    const body = parseWith(revokeBody, req.body ?? {});
    const { store } = o.tenant(req);
    store.credentialAcceptances.revoke(body.machineKey, id, o.clock.now().toISOString());
    return { ok: true };
  });

  app.get('/api/credential-check', async (req) => o.tenant(req).store.credentialAcceptances.settings());

  app.post('/ui/api/credential-check', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the credential check');
    const t = o.tenant(req);
    const to = parseWith(credentialCheckBody, req.body);
    t.store.tx(() => {
      const from = t.store.credentialAcceptances.settings();
      if (from.strict === to.strict) return;
      t.store.credentialAcceptances.setSettings(to);
      t.store.events.append({ type: 'credential_check.changed', data: { from, to, by: personOf(s) } });
    });
    return t.store.credentialAcceptances.settings();
  });
}

/** The API reference's entries for these routes (src/http/openapi.ts). */
export const MACHINE_CREDENTIAL_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/:id/credentials/accept', tag: 'Machines and usage', summary: 'Use a machine anyway, or acknowledge its credential warning (issues #1459, #1467)', description: 'Records the admin\'s acknowledgement of the infra credentials `credentials` on `machineKey`, and clears a stop: the machine takes jobs, in strict mode too, and its warning folds. A credential found later that the acknowledgement did not name raises the warning again.', role: 'admin', body: acceptBody, returns: '`{ ok: true }`', errors: [401] },
  { method: 'post', path: '/ui/api/machines/:id/credentials/revoke', tag: 'Machines and usage', summary: 'Stop a machine from taking jobs for its credentials (issue #1467)', description: 'The machine takes no new job while its job user holds infra credentials, whatever strict mode says, until an admin uses it anyway.', role: 'admin', body: revokeBody, returns: '`{ ok: true }`', errors: [401] },
  { method: 'get', path: '/api/credential-check', tag: 'Machines and usage', summary: 'The credential check\'s settings (issue #1467)', description: '`strict`: false, the default — a machine whose job user holds infra credentials takes jobs with a warning. True: such a machine takes no job until an admin uses it anyway.', returns: '`{ strict: boolean }`' },
  { method: 'post', path: '/ui/api/credential-check', tag: 'Machines and usage', summary: 'Turn strict mode of the credential check on or off (issue #1467)', description: 'Recorded as `credential_check.changed` when it changes. Applies at the next decision.', role: 'admin', body: credentialCheckBody, returns: '`{ strict: boolean }`', errors: [400, 401] },
];
