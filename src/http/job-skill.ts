// The skill broker's route (issue #582, design.md "Skills: what the hopper can set up for a box"): a running job asks
// the hopper what it can set up, or loads one skill, outside the UI session, on the hopper's own URL and behind the
// Host guard, like the GitHub proxy (job-github.ts).
//
//   POST /job/skill   `Authorization: Bearer <the job's proxy token>`; no fields for the catalog, else `name` and
//                     `asset`, as a form (what `hopper-skill` sends, src/skills/script.ts) or JSON. Plain text back:
//                     the catalog, the skill, or `no: <reason>`; 202 `waiting: …` while a person is asked for the
//                     credential a skill needs (issue #583: a credential request, kept in memory). With `wait` (and
//                     `timeout`, seconds), the 202 opens a watch on the request and names it: the answer comes on the
//                     job stream (issue #613, job-stream.ts). It changes no job, question, webhook or setting. A
//                     template request (issue #716, `name` sandbox-template, `needs`) saves the template the needs
//                     say, never widening one, and approves it only inside the user's read policy or with skip
//                     template approval on. A sandbox request (issue #991, `name` sandbox, `needs`) then asks for a box
//                     of that template, which starts once a person or skip sandbox approval approves it. Issue #998:
//                     a 202 with no `wait` opens a watch too, one per job and request; when it is answered and the job
//                     is on its own wait (HOPPER_WAITING), the hopper ends that wait with the answer. Issue #2206:
//                     a template request's `actions` are checked first (src/vault/template-actions.ts).
import type { FastifyInstance } from 'fastify';
import type { Access } from '../authz/service.ts';
import { createSkillBroker, createSkillWaits, SKILL_PATH, type BoxSecret, type SkillUser, type SkillWaits } from '../skills/index.ts';
import { requestTemplate } from '../skills/template-request.ts';
import { mintTarget } from '../domain/minting.ts';
import type { Tenants } from './tenants.ts';
import { templateRequestUser } from './vault.ts';
import { createActionSimulator } from '../vault/action-simulation.ts';
import { checkTemplateActions } from '../vault/template-actions.ts';

/** A user's side, from their GitHub proxy's (their jobs, the token check, their log) and their vault (a box's template). */
function skillUser(tenants: Tenants, id: string): SkillUser | undefined {
  const parts = tenants.user(id);
  if (!parts) return undefined;
  const { holds, job, record } = parts.githubProxy.user;
  const boxSecrets = (names: readonly string[]): BoxSecret[] => {
    const all = parts.vault.view().secrets;
    return names.map((name) => {
      const s = all.find((x) => x.name === name);
      // What it is for (issue #583): the skill a person gave it for, the kind, their words. Never a value.
      return { name, ...(s?.scope ? { scope: s.scope } : {}), ...(s?.skill ? { skill: s.skill } : {}), ...(s?.kind ? { kind: s.kind } : {}), ...(s?.note ? { note: s.note } : {}) };
    });
  };
  return {
    id, holds, job, record,
    mintsFor(form, asset) {
      const target = mintTarget(form, { operation: 'read', asset });
      return typeof target !== 'string' && parts.vault.view().secrets.some((s) => s.mints?.kind === target.mintsFor.kind && s.mints.name === target.mintsFor.name);
    },
    box(machine) {
      const { template, secrets } = parts.vault.scopeOf(machine);
      return { ...(template ? { template } : {}), secrets: boxSecrets(secrets) };
    },
    // Issue #2356: a job off a box asks for a credential for the template of its approved sandbox runs: its box steps get it.
    runsOf(job, template) {
      const t = parts.sandboxRequests.runnable(job.id).includes(template) ? parts.vault.view().templates.find((x) => x.name === template) : undefined;
      return t ? { template, secrets: boxSecrets(t.gives) } : undefined;
    },
    need: (ask, asker) => parts.vault.need(ask, asker),
    // Issue #716: the template the job's needs say, through the vault's own save and approve, the user's read policy deciding.
    requestTemplate: (ask, job, about) => requestTemplate(templateRequestUser(parts), ask, `job ${job.id}`, job.id, about),
    // Issue #991: a box of that template for the job, started once a person or skip sandbox approval approves it.
    template: (name) => parts.vault.view().templates.find((t) => t.name === name),
    sandbox: (template, job, about) => parts.sandboxRequests.ask(job.id, template, about),
    sandboxWaits: (template, job, about) => parts.sandboxRequests.waited(job.id, template, about),
    bastions: parts.bastions, // issue #2146
    databases: { readDatabase: (ask) => parts.vault.readDatabase(ask) }, // issue #2231
    outsideStamp: (profiles, job) => parts.sandboxRequests.outside(job.id, profiles), // issue #655 part 16
    // Issue #2206, part 2: IAM simulates the role with a read session of hopper-read, minted as topology discovery mints one.
    actionCheck: (needs, said, job, why) => checkTemplateActions({ store: parts.store, appliesOff: () => parts.needSteps.appliesOff(),
      simulator: createActionSimulator({ mint: (asset) => parts.vault.mintForDiscovery(asset) }) }, needs, said, job.id, why, new Date()),
  };
}

/** The routes; the skill waits they keep, for the job stream's route to ask again when a job subscribes. */
export function jobSkillRoutes(app: FastifyInstance, o: { tenants: Tenants; access: Access }): SkillWaits {
  const broker = createSkillBroker({
    user: (id) => skillUser(o.tenants, id),
    decide: (request) => o.access.decideMint(request),
    log: (line) => console.warn(line),
  });
  const waits = createSkillWaits({
    broker,
    user(id) {
      const parts = o.tenants.user(id);
      if (!parts) return undefined;
      return {
        stream: parts.jobStream, events: parts.store.events,
        // Issue #998: an answer the job asked for ends its own wait (HOPPER_WAITING), as a person's end-wait does.
        endWait(jobId, answer) {
          if (parts.store.jobs.get(jobId)?.status !== 'waiting_on') return;
          try {
            parts.engine.endWait(jobId, answer, 'hopper');
          } catch (e) {
            // Its agent went on by itself meanwhile: nothing waits any more.
            console.warn(`hopper: skills: ending the wait of job ${jobId} failed: ${(e as Error).message}`);
          }
        },
      };
    },
    log: (line) => console.warn(line),
  });
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post(SKILL_PATH, async (req, reply) => {
      const answer = await waits.handle(req.headers.authorization, req.body);
      return reply.code(answer.status).type('text/plain; charset=utf-8').send(answer.text);
    });
  });
  return waits;
}
