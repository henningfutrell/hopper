// The skill broker's route (issue #582, design.md "Skills: what the hopper can set up for a box"): a running job asks
// the hopper what it can set up, or loads one skill, outside the UI session, on the hopper's own URL and behind the
// Host guard, like the GitHub proxy (job-github.ts).
//
//   POST /job/skill   `Authorization: Bearer <the job's proxy token>`; no fields for the catalog, else `name` and
//                     `asset`, as a form (what `hopper-skill` sends, src/skills/script.ts) or JSON. Plain text back:
//                     the catalog, the skill, or `no: <reason>`. It changes no job, question, webhook or setting.
import type { FastifyInstance } from 'fastify';
import type { Access } from '../authz/service.ts';
import { createSkillBroker, SKILL_PATH, type SkillUser } from '../skills/index.ts';
import { mintTarget } from '../domain/minting.ts';
import type { Tenants } from './tenants.ts';

/** A user's side, from their GitHub proxy's (their jobs, the token check, their log) and their vault (a box's template). */
function skillUser(tenants: Tenants, id: string): SkillUser | undefined {
  const parts = tenants.user(id);
  if (!parts) return undefined;
  const { holds, job, record } = parts.githubProxy.user;
  return {
    id, holds, job, record,
    mintsFor(form, asset) {
      const target = mintTarget(form, { operation: 'read', asset });
      return typeof target !== 'string' && parts.vault.view().secrets.some((s) => s.mints?.kind === target.mintsFor.kind && s.mints.name === target.mintsFor.name);
    },
    box(machine) {
      const { template, secrets } = parts.vault.scopeOf(machine);
      const all = parts.vault.view().secrets;
      return { ...(template ? { template } : {}), secrets: secrets.map((name) => {
        const scope = all.find((s) => s.name === name)?.scope;
        return { name, ...(scope ? { scope } : {}) };
      }) };
    },
  };
}

export function jobSkillRoutes(app: FastifyInstance, o: { tenants: Tenants; access: Access }): void {
  const broker = createSkillBroker({
    user: (id) => skillUser(o.tenants, id),
    decide: (request) => o.access.decideMint(request),
    log: (line) => console.warn(line),
  });
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post(SKILL_PATH, async (req, reply) => {
      const answer = await broker.handle(req.headers.authorization, req.body);
      return reply.code(answer.status).type('text/plain; charset=utf-8').send(answer.text);
    });
  });
}
