// Step schedules (issue #2716, design.md "Step schedules"): a person saves, removes, grants the vault to and runs now a
// box step the hopper runs each day with no job; `hopper schedule` posts here. Each act a box action, least role operator.
// The grant is decided by Access as a job's vault grant is (OpenFGA `vault_grant#can_grant`, the key `schedule:<name>`),
// and a delegate approver may not give one: a delegate decides only what waits, and a schedule's grant waits for nothing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import { ACCESS_UNAVAILABLE } from '../../domain/access.ts';
import { scheduleGrantKey, type StepSchedulesView } from '../../domain/step-schedules.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import type { ApiGrants } from './api-grants.ts';
import { approverOf, delegateOf } from './delegates.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const nameParams = z.object({ name: z.string() });
const named = { name: z.string() };

export const stepScheduleBody = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('save'), ...named, template: z.string(), repo: z.string(), input: z.string().optional(), script: z.string(),
    daily: z.string(), timeoutSeconds: z.number().int(),
  }),
  z.strictObject({ action: z.literal('remove'), ...named }),
  z.strictObject({ action: z.literal('grant'), ...named }),
  z.strictObject({ action: z.literal('revoke'), ...named }),
  z.strictObject({ action: z.literal('run'), ...named }),
]);

export const STEP_SCHEDULE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/step-schedules', tag: 'Vault', summary: 'The step schedules', description: 'Issue #2716: each box step a person scheduled — its template, the folder and script of a repository it runs at the default branch, its daily time in UTC, its timeout, its vault grant —, its next due time and its newest run. `failed`: the schedules whose newest run did not succeed, which Needs you lists. `hopper schedule list` reads it.', returns: '`StepSchedulesView`' },
  { method: 'get', path: '/api/step-schedules/:name', tag: 'Vault', summary: 'A step schedule\'s runs', description: 'Issue #2716: the schedule and its newest 30 runs, newest first: start, end, outcome, exit code, problem, and the output, each vault secret masked. 404: no such schedule. `hopper schedule runs` reads it.', returns: '`StepScheduleRunsView`', errors: [404] },
  { method: 'post', path: '/ui/api/step-schedules', tag: 'Vault', summary: 'Save, remove, grant or run a step schedule', description: 'Issue #2716. `save` (`name`, `template`, `repo` `owner/name`, `input` a folder of it (default: the script\'s folder), `script` a file in `input`, `daily` `HH:MM` UTC, `timeoutSeconds`): the hopper runs `sh <script>` in a new sandbox of the template at each due time, the folder at the repository\'s default branch in its work directory at the same path, read with the user\'s own GitHub connection; a due time before the save is not run (`step_schedule.saved`). A template the vault mints credentials for takes no schedule (409, not built); a save that changes the template, the repository, the folder or the script takes the vault grant back. `remove` (409 while a run has not ended, `step_schedule.removed`). `grant` gives the schedule the vault: its runs get the vault secrets the template gives, copied into the sandbox (`step_schedule.granted`); Access decides first (OpenFGA `vault_grant#can_grant`, the key `schedule:<name>`; 403, 503 when it cannot be asked), and a delegate approver is refused (403). `revoke` takes it back (409: none). `run` runs it now, once (409 while a run has not ended; 503 with no container runtime). 404: no such schedule. A box action. `hopper schedule` posts here.', role: 'operator', body: stepScheduleBody, returns: '`{ schedule: StepScheduleView }`, `{ run: ScheduledRun }` for `run`, `{ removed: true }` for `remove`', errors: [400, 403, 404, 409, 503] },
];

export function registerStepScheduleRoutes(app: FastifyInstance, o: {
  operator: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideVaultGrant'>; grants: Pick<ApiGrants, 'live'>;
}): void {
  app.get('/api/step-schedules', async (req): Promise<StepSchedulesView> => o.tenant(req).stepSchedules.view());
  app.get('/api/step-schedules/:name', async (req) => {
    const { name } = parseWith(nameParams, req.params);
    const v = o.tenant(req).stepSchedules.runs(name);
    if (!v) throw new HttpError(404, `no step schedule ${name}`);
    return v;
  });
  app.post('/ui/api/step-schedules', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change a step schedule');
    const b = parseWith(stepScheduleBody, req.body);
    const schedules = o.tenant(req).stepSchedules;
    const delegate = delegateOf(o.grants, s);
    const by = approverOf(delegate, s);
    const answer = <T extends object>(r: T | { status: number; no: string }): T => {
      if ('no' in r) throw new HttpError(r.status, r.no);
      return r as T;
    };
    if (b.action === 'save') {
      const input = b.input ?? b.script.split('/').slice(0, -1).join('/');
      return answer(schedules.save({ name: b.name, template: b.template, repo: b.repo, input, script: b.script, daily: b.daily, timeoutSeconds: b.timeoutSeconds }, by));
    }
    if (b.action === 'remove') {
      const r = schedules.remove(b.name, by);
      if (r !== true) throw new HttpError(r.status, r.no);
      return { removed: true };
    }
    if (b.action === 'run') return answer(schedules.runNow(b.name, by));
    if (b.action === 'grant') {
      if (delegate) throw new HttpError(403, 'a delegate approver gives no vault grant to a step schedule: a person grants it');
      const d = await o.access.decideVaultGrant(s.userId, { ownerId: s.userId, key: scheduleGrantKey(b.name) });
      if (!d.allowed && d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      if (!d.allowed) throw new HttpError(403, `granting the schedule the vault is refused: ${d.reason}`);
      return answer(schedules.grant(b.name, by));
    }
    return answer(schedules.revoke(b.name, by));
  });
}
