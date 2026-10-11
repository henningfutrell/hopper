// A running job's vault and sandbox boxes (issue #718, item 4; design.md "The vault and sandbox boxes through the job
// door"): what an agent sets up for itself with no UI session, outside it, on the hopper's own URL and behind the Host
// guard, like the artifacts (job-artifacts.ts). `Authorization: Bearer <the job's proxy token>`, honoured only while its
// job is at work; the job acts for its own user, in that user's vault, and on nothing else.
//
//   GET  /job/vault      the user's vault view, as GET /api/vault: never a value
//   POST /job/vault      JSON `{ action: 'set', … }` or `{ action: 'save-template', … }`, as POST /ui/api/vault takes them
//   GET  /job/sandbox    the user's sandbox boxes, as GET /api/sandboxes
//   POST /job/sandbox    JSON `{ template, agent?, params? }`: a box of an approved template, as POST /ui/api/machines/sandbox
//
// Access (OpenFGA, `vault#can_set_secret`, `#can_save_template`, `#can_launch_box`) decides each change, the job's user
// told as the vault's owner. A job never approves, revokes, removes or gives: those stay a person's, so a template a job
// saves waits for a person as one the UI saves does. Each change is the vault's own event, `by: job <id>`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../authz/access-port.ts';
import { ACCESS_UNAVAILABLE, type Job, type JobStatus, type VaultAction } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { LaunchRefused, type Sandboxes } from '../sandbox/service.ts';
import { vaultView } from '../vault/vault.ts';
import { HttpError, parseWith } from './errors.ts';
import type { TenantParts, Tenants } from './tenants.ts';
import { machineSandboxBody } from './ui/machine-join.ts';
import { saveTemplateEdit, setSecretEdit, VAULT_STATUS } from './ui/vault.ts';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;

/** What a job may change in its user's vault: a secret's value, a template. Nothing that approves. */
export const jobVaultBody = z.discriminatedUnion('action', [setSecretEdit, saveTemplateEdit]);

/** The job the token names, at work, its user and their parts; else a 401 that says why. */
function askerOf(tenants: Tenants, req: FastifyRequest): { t: TenantParts; job: Job; userId: string } {
  const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const t = parts ? tenants.user(parts.userId) : undefined;
  const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
  if (!parts || !t || !job) throw new HttpError(401, 'the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.');
  if (!AT_WORK.includes(job.status)) throw new HttpError(401, `job ${job.id} is ${job.status}, not at work: only a running job changes its vault.`);
  return { t, job, userId: parts.userId };
}

export function jobVaultRoutes(app: FastifyInstance, o: { tenants: Tenants; access: Pick<Access, 'decideVaultAction'>; sandboxes: Pick<Sandboxes, 'view' | 'launch'> }): void {
  /** Access's answer for the job's user: a 503 when OpenFGA cannot be asked, a 403 with its reason when it refuses. */
  const allow = async (userId: string, action: VaultAction): Promise<void> => {
    const d = await o.access.decideVaultAction({ userId, action });
    if (d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
    if (!d.allowed) throw new HttpError(403, `access refused: ${d.reason}`);
  };
  const noStore = (reply: FastifyReply): void => { reply.header('cache-control', 'no-store'); };

  app.get('/job/vault', async (req, reply) => {
    noStore(reply);
    return await vaultView(askerOf(o.tenants, req).t.vault);
  });

  app.post('/job/vault', async (req, reply) => {
    noStore(reply);
    const { t, job, userId } = askerOf(o.tenants, req);
    const edit = parseWith(jobVaultBody, req.body ?? {});
    const by = `job ${job.id}`;
    let r;
    if (edit.action === 'set') {
      await allow(userId, 'set-secret');
      const { action: _a, ...secret } = edit;
      r = await t.vault.set(secret, by);
    } else {
      await allow(userId, 'save-template');
      r = await t.vault.saveTemplate(edit, by);
    }
    if (!r.ok) throw new HttpError(VAULT_STATUS[r.code], r.error);
    return await vaultView(t.vault);
  });

  app.get('/job/sandbox', async (req, reply) => {
    noStore(reply);
    return await o.sandboxes.view(askerOf(o.tenants, req).userId);
  });

  app.post('/job/sandbox', async (req) => {
    const { t, userId } = askerOf(o.tenants, req);
    const { agent, template: name, params } = parseWith(machineSandboxBody, req.body ?? {});
    if (name === undefined) throw new HttpError(400, 'name a template: a job launches only a box of an approved template');
    const template = t.vault.view().templates.find((x) => x.name === name);
    if (!template) throw new HttpError(404, `no template ${name}`);
    await allow(userId, 'launch-box');
    try {
      return await o.sandboxes.launch(userId, { agent, params, template });
    } catch (e) {
      if (e instanceof LaunchRefused) throw new HttpError(e.status, e.message);
      throw new HttpError(502, `the sandbox box did not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
