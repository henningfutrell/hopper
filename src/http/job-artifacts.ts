// A running job's artifacts (issue #624, design.md "Artifacts"): what `hopper-artifact` asks, outside the UI session, on
// the hopper's own URL and behind the Host guard, like the skill broker (job-skill.ts). `Authorization: Bearer <the job's
// proxy token>`, honoured only while its job is at work. Every value but the file is in the query string.
//
//   POST /job/artifacts?name=&title=&type=   the file as the body (application/octet-stream): kept, 201
//   GET  /job/artifacts[?all=1][&markdown=1] the job's artifacts (all: every job's of the user)
//   GET  /job/artifacts/:id[?content=1]      one, or its content
//   POST /job/artifacts/:id/share?user=NAME | ?public=1[&hours=N] | ?revoke=SHARE
//   POST /job/artifacts/:id/rm
//
// Plain text back, few tokens, or JSON when `Accept: application/json` asks for it; every no says why. It changes no
// job, question, webhook or setting: only the user's artifacts, each change an event on the job's timeline.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ARTIFACT_PATH, isRefusal, type Refusal, type ShareMade } from '../artifacts/index.ts';
import { LINK_PATH } from '../artifacts/content.ts';
import { ARTIFACT_MAX_BYTES, type Artifact, type ArtifactShare } from '../domain/artifacts.ts';
import type { Job, JobStatus } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import type { ArtifactEdge } from './artifacts.ts';
import type { TenantParts, Tenants } from './tenants.ts';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;
const ID = /^[A-Za-z0-9-]{1,100}$/;

type Asker = { t: TenantParts; job: Job } | { status: number; text: string };

function askerOf(tenants: Tenants, authorization: string | undefined): Asker {
  const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
  const t = parts ? tenants.user(parts.userId) : undefined;
  const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
  if (!parts || !t || !job) return { status: 401, text: 'the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.' };
  if (!AT_WORK.includes(job.status)) return { status: 401, text: `job ${job.id} is ${job.status}, not at work: only a running job puts artifacts.` };
  return { t, job };
}

const wantsJson = (req: FastifyRequest): boolean => /\bapplication\/json\b/.test(req.headers.accept ?? '');
const q = (req: FastifyRequest, key: string): string | undefined => {
  const v = (req.query as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

const answer = (req: FastifyRequest, reply: FastifyReply, status: number, json: Record<string, unknown>, text: string): FastifyReply =>
  (wantsJson(req)
    ? reply.code(status).type('application/json; charset=utf-8').send(`${JSON.stringify({ ok: status < 400, ...json })}\n`)
    : reply.code(status).type('text/plain; charset=utf-8').send(text.endsWith('\n') ? text : `${text}\n`));
const no = (req: FastifyRequest, reply: FastifyReply, r: Refusal | { status: number; text: string }): FastifyReply => {
  const why = 'no' in r ? r.no : r.text;
  return answer(req, reply, r.status, { error: why }, `no: ${why}`);
};

const line = (a: Artifact, url: string): string => `${a.id}  ${a.title}  ${a.type}  ${a.size} bytes  ${a.createdAt}  ${url}`;
const shareLine = (s: ArtifactShare): string => `${s.id}  ${s.kind === 'user' ? `user ${s.userName ?? s.userId}` : `public link until ${s.expiresAt}`}${s.revokedAt ? `  revoked ${s.revokedAt}` : ''}`;

export function jobArtifactRoutes(app: FastifyInstance, o: { tenants: Tenants; edge: ArtifactEdge }): void {
  const brief = (t: TenantParts, a: Artifact) => ({ ...a, url: o.edge.url(o.edge.base(t), a.id) });
  const urlOf = (t: TenantParts, id: string): string => o.edge.url(o.edge.base(t), id);
  void app.register(async (scope) => {
    // The file, whole: the user's limit is checked after; nothing larger than any limit may allow is read.
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ARTIFACT_MAX_BYTES + 1 }, (_req, body, done) => { done(null, body); });

    scope.post(ARTIFACT_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const name = q(req, 'name');
      if (!name) return no(req, reply, { status: 400, text: 'name the file: put FILE' });
      if (!Buffer.isBuffer(req.body)) return no(req, reply, { status: 400, text: 'send the file as the body, content-type application/octet-stream' });
      const title = q(req, 'title');
      const type = q(req, 'type');
      const r = who.t.artifacts.put(who.job, { name, content: req.body, ...(title ? { title } : {}), ...(type ? { type } : {}) });
      if (isRefusal(r)) return no(req, reply, r);
      const url = urlOf(who.t, r.id);
      return answer(req, reply, 201, { artifact: brief(who.t, r) }, `put: ${r.id}  ${r.title}  ${r.type}  ${r.size} bytes\nurl: ${url}\n`);
    });

    scope.get(ARTIFACT_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const list = who.t.artifacts.list(q(req, 'all') ? {} : { jobId: who.job.id });
      if (q(req, 'markdown')) {
        // A link on GitHub only through the public URL: a local address is a machine detail (the publishing rule).
        const pub = o.edge.publicBase();
        const md = list.map((a) => (pub ? `- [${a.title.replaceAll(/[[\]]/g, '')}](${pub}/#artifacts/${a.id})` : `- ${a.title} (an artifact on the hopper)`)).join('\n');
        return answer(req, reply, 200, { markdown: md }, md || '(no artifacts)');
      }
      return answer(req, reply, 200, { artifacts: list.map((a) => brief(who.t, a)) }, list.length ? list.map((a) => line(a, urlOf(who.t, a.id))).join('\n') : '(no artifacts)');
    });

    scope.get<{ Params: { id: string } }>(`${ARTIFACT_PATH}/:id`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const a = ID.test(req.params.id) ? who.t.artifacts.get(req.params.id) : undefined;
      if (!a) return no(req, reply, { status: 404, text: `there is no artifact ${req.params.id}` });
      if (q(req, 'content')) return reply.type('application/octet-stream').send(who.t.artifacts.content(a.id));
      const shares = who.t.store.artifacts.shares(a.id);
      return answer(req, reply, 200, { artifact: { ...brief(who.t, a), shares } }, `${line(a, urlOf(who.t, a.id))}\n${shares.map(shareLine).join('\n')}`);
    });

    scope.post<{ Params: { id: string } }>(`${ARTIFACT_PATH}/:id/share`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const by = `job ${who.job.id}`;
      const id = req.params.id;
      const revoke = q(req, 'revoke');
      if (revoke) {
        const r = who.t.artifacts.revoke(id, revoke, by);
        return isRefusal(r) ? no(req, reply, r) : answer(req, reply, 200, { share: r }, `revoked: ${shareLine(r)}`);
      }
      const name = q(req, 'user');
      let made: ShareMade | Refusal;
      if (name) {
        const user = o.tenants.list().find((u) => u.name === name);
        if (!user) return no(req, reply, { status: 404, text: `this hopper has no user ${name}` });
        made = who.t.artifacts.share(id, { user: { id: user.id, name: user.name } }, by);
      } else if (q(req, 'public')) {
        const hours = q(req, 'hours');
        made = who.t.artifacts.share(id, { link: true, ...(hours !== undefined ? { hours: Number(hours) } : {}) }, by);
      } else {
        return no(req, reply, { status: 400, text: 'say who: --user NAME, --public [--hours N], or --revoke SHARE' });
      }
      if (isRefusal(made)) return no(req, reply, made);
      const link = made.token ? `${o.edge.base(who.t)}${LINK_PATH}/${made.token}` : undefined;
      return answer(req, reply, 201, { share: made.share, ...(link ? { link } : {}) }, `shared: ${shareLine(made.share)}${link ? `\nlink: ${link}` : `\nurl: ${urlOf(who.t, id)}`}`);
    });

    scope.post<{ Params: { id: string } }>(`${ARTIFACT_PATH}/:id/rm`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const r = who.t.artifacts.remove(req.params.id, `job ${who.job.id}`);
      return isRefusal(r) ? no(req, reply, r) : answer(req, reply, 200, { removed: r.id }, `removed: ${r.id}  ${r.title}`);
    });
  });
}
