// Out-of-band changes on Infra (issue #871, design.md "Out-of-band changes"): the infrastructure changes the
// user's jobs' checks found that did not come through IaC or GitOps, each with its mark; a person's mark on one; and the
// controller identities, whose writes are GitOps's. Tracking only: nothing here reverts a change. Part 2: an outside
// collector reports signals here with an API token (scope `out-of-band:signals`), judged by the same rule as a job's check.
// Registered with the infra plans' routes (`infra-plans.ts`).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MARKS, SIGNALS_MAX, type Signal } from '../../domain/out-of-band.ts';
import { isPlanRefusal } from '../../infra-plans/service.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** A report of signals: a collector with more sends more than one (as `POST /job/infra-signals`). */
const SIGNAL_BODY_LIMIT = 16 * 1024 * 1024;

/** Each signal is checked by the rule's own check (`signalProblem`), which says which one is not whole and why. */
export const signalsBody = z.strictObject({ signals: z.array(z.record(z.string(), z.unknown())).max(SIGNALS_MAX) });

export const outOfBandBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('mark'), change: z.string().max(64), mark: z.enum(MARKS), reason: z.string().max(1000).optional() }),
  z.strictObject({ action: z.literal('controllers'), identities: z.array(z.string().max(300)).max(100) }),
]);

export const OUT_OF_BAND_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/out-of-band', tag: 'Infra', summary: 'Infra: out-of-band changes', description: 'Issue #871: the infrastructure changes the user\'s jobs\' read-only checks reported that did not come through IaC or GitOps, newest first, at most 200: each one\'s `source` (`gitops`, `terraform-plan`, `cloudtrail`, `kube-audit`), `key` (the signal\'s own id), `target`, `what`, `who`, `at`, `detail`, the `job` that reported it, `recordedAt`, and `marked` once a person marked it; and `controllers`, the controller identities. A job reports signals with POST /job/infra-signals (its proxy token). Not cached.', returns: '{ changes: OutOfBandView[]; controllers: string[] }' },
  { method: 'post', path: '/ui/api/out-of-band/signals', tag: 'Infra', summary: 'Report signals from an outside collector', description: `Issue #871 part 2: what a read-only check outside the hopper found — drift, audit-log writes —, as \`POST /job/infra-signals\` takes from a job: \`signals\`, 1 to ${SIGNALS_MAX}, each \`source\`, \`key\`, \`target\`, \`what\`, \`who\`, \`at\`, \`detail\`. Each is judged by the same rule; the out-of-band ones are kept with \`reporter\` (the API token's label, else who signed in) in place of a job, each \`infra.out_of_band_recorded\` on no job's timeline, sent to the notifiers. Meant for an API token whose grant has the scope \`out-of-band:signals\`. Answers what was recorded (without \`detail\`), what was in band and why, and how many were reported before. 400: a signal that is not whole, saying which and why.`, role: 'operator', body: signalsBody, returns: '{ recorded: OutOfBandChange[]; inBand: { source; key; why }[]; known: number }', errors: [400] },
  { method: 'post', path: '/ui/api/out-of-band', tag: 'Infra', summary: 'Mark an out-of-band change, or set the controller identities', description: 'Issue #871. `action` `mark`: `change` its id, `mark` `adopted` (brought back into git), `reverted`, or `accepted` with a `reason`; a row of its own (`infra.out_of_band_marked`); the change does not change; nothing is reverted by the hopper. 404: no such change; 409: marked already. `action` `controllers`: `identities`, the whole list of principals whose writes are GitOps\'s (a trailing `*` names a group; `*` alone is refused); `infra.controllers_changed`.', role: 'admin', body: outOfBandBody, returns: '{ change: OutOfBandView } | { controllers: string[] }', errors: [400, 404, 409] },
];

export function outOfBandReadRoutes(app: FastifyInstance, { tenant }: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/out-of-band', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const changes = tenant(req).githubProxy.outOfBand;
    return { changes: changes.list(), controllers: changes.controllers() };
  });
}

export function registerOutOfBandRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/out-of-band/signals', { ...o.operator, bodyLimit: SIGNAL_BODY_LIMIT }, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to report signals');
    const b = parseWith(signalsBody, req.body);
    const r = o.tenant(req).githubProxy.outOfBand.report({ reporter: s.label ?? personOf(s) }, b.signals as unknown as Signal[]);
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return { recorded: r.recorded.map(({ detail: _detail, ...c }) => c), inBand: r.inBand, known: r.known };
  });
  app.post('/ui/api/out-of-band', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to mark a change');
    const b = parseWith(outOfBandBody, req.body);
    const changes = o.tenant(req).githubProxy.outOfBand;
    const by = personOf(s);
    if (b.action === 'controllers') {
      const r = changes.setControllers(b.identities.filter((i) => i.trim()), by);
      if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
      return { controllers: r };
    }
    const r = changes.mark(b.change, b.mark, b.reason, by);
    if (isPlanRefusal(r)) throw new HttpError(r.status, r.no);
    return { change: r };
  });
}
