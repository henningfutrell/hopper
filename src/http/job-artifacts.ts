// A running job's artifacts (issue #624, design.md "Artifacts"): what `hopper-artifact` asks, outside the UI session, on
// the hopper's own URL and behind the Host guard, like the skill broker (job-skill.ts). `Authorization: Bearer <the job's
// proxy token>`, honoured only while its job is at work. Every value but the file is in the query string.
//
//   POST /job/artifacts?name=&title=&type=   the file as the body (application/octet-stream): kept, 201, with a
//                                            warning when HTML has no drawing (issue #675), or when it looks like a
//                                            revision of an artifact of the user's and has no `to` or `new` (issue #687)
//   GET  /job/artifacts[?all=1][&markdown=1] the job's artifacts (all: every job's of the user)
//   GET  /job/artifacts/:id[?content=1]      one, or its content
//   POST /job/artifacts/:id/share?owner=1 | ?user=NAME | ?public=1[&hours=N] | ?revoke=SHARE
//                                            the owner: shown — its link posted on the job's issue (issue #673)
//   POST /job/artifacts/:id/rm
//
// Plain text back, few tokens, or JSON when `Accept: application/json` asks for it; every no says why. It changes no
// job, question, webhook or setting: only the user's artifacts, each change an event on the job's timeline.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ARTIFACT_PATH, isRefusal, type Refusal, type ShareMade } from '../artifacts/index.ts';
import { LINK_PATH } from '../artifacts/content.ts';
import { ARTIFACT_MAX_BYTES, type Artifact, type ArtifactRevision, type ArtifactShare } from '../domain/artifacts.ts';
import type { Job, JobStatus } from '../domain/types.ts';
import type { GitHubProxy } from '../github-proxy/index.ts';
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
const revisionLine = (r: ArtifactRevision): string =>
  `${r.n}${r.latest ? ' (latest)' : ''}  ${r.createdAt}  ${r.by}  ${r.title}  ${r.size} bytes${r.pinned ? '  pinned' : ''}${r.note ? `  — ${r.note}` : ''}`;
const shareLine = (s: ArtifactShare): string => `${s.id}  ${s.kind === 'user' ? `user ${s.userName ?? s.userId}` : `public link until ${s.expiresAt}`}${s.revokedAt ? `  revoked ${s.revokedAt}` : ''}`;

/**
 * The comment that shows an artifact on its issue (issue #673), under the publishing rule: a link only through the public
 * URL, else its id and where to open it — never a local address. Its title is the job's text, on one line.
 */
export function shownComment(a: Artifact, publicBase: string | undefined): string {
  const title = a.title.replace(/\s+/g, ' ').replace(/[[\]*_`<>]/g, '');
  const where = publicBase
    ? `[Open it](${publicBase}/#artifacts/${a.id})`
    : `Open it in the hopper's Artifacts view: artifact \`${a.id}\`.`;
  return `An artifact for this issue is on the hopper: **${title}** (${a.type}, ${a.size} bytes).\n\n${where}`;
}

export function jobArtifactRoutes(app: FastifyInstance, o: { tenants: Tenants; edge: ArtifactEdge; github: GitHubProxy }): void {
  const brief = (t: TenantParts, a: Artifact) => ({ ...a, url: o.edge.url(o.edge.base(t), a.id) });
  const urlOf = (t: TenantParts, id: string): string => o.edge.url(o.edge.base(t), id);
  /**
   * A share with the owner (issue #673): they see it already, so nothing is made. The artifact is shown instead: its link
   * posted on the job's issue as the job's own comment, through the GitHub proxy (its policy, limits and timeline
   * events), and `artifact.posted` on the job's timeline. A comment that cannot be posted is a no, with why.
   */
  const shown = async (req: FastifyRequest, reply: FastifyReply, who: { t: TenantParts; job: Job }, id: string, by: string): Promise<FastifyReply> => {
    const a = who.t.artifacts.get(id)!;
    const url = urlOf(who.t, id);
    const head = `shown: ${a.id}  ${a.title}: the owner sees it already\nurl: ${url}`;
    const { repo, number } = who.job.source ?? {};
    if (!repo || !number) {
      who.t.artifacts.posted(id, by, { noIssue: true });
      return answer(req, reply, 200, { owner: true, url }, `${head}\nposted: nowhere, the job has no issue`);
    }
    const r = await o.github.handle(req.headers.authorization, { op: 'issue.comment', repo, number, body: shownComment(a, o.edge.publicBase()) });
    const comment = typeof r.body.url === 'string' ? r.body.url : undefined;
    if (r.status === 200 && comment) {
      who.t.artifacts.posted(id, by, { comment });
      return answer(req, reply, 200, { owner: true, url, posted: comment }, `${head}\nposted: ${comment}`);
    }
    const error = typeof r.body.error === 'string' ? r.body.error : `the hopper answered ${r.status}`;
    who.t.artifacts.posted(id, by, { error });
    return answer(req, reply, 502, { owner: true, url, error: `the owner sees it already, but its link was not posted on ${repo}#${number}: ${error}` },
      `no: the owner sees it already, but its link was not posted on ${repo}#${number}: ${error}`);
  };
  void app.register(async (scope) => {
    // The file, whole: the user's limit is checked after; nothing larger than any limit may allow is read.
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ARTIFACT_MAX_BYTES + 1 }, (_req, body, done) => { done(null, body); });

    scope.post(ARTIFACT_PATH, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const name = q(req, 'name');
      if (!name) return no(req, reply, { status: 400, text: 'name the file: put FILE' });
      if (!Buffer.isBuffer(req.body)) return no(req, reply, { status: 400, text: 'send the file as the body, content-type application/octet-stream' });
      const [title, summary, type, to, note] = ['title', 'summary', 'type', 'to', 'note'].map((k) => q(req, k));
      if (to !== undefined && !ID.test(to)) return no(req, reply, { status: 400, text: `${to} is not an artifact id` });
      const r = who.t.artifacts.put(who.job, {
        name, content: req.body, ...(q(req, 'new') ? { separate: true } : {}), ...(title ? { title } : {}), ...(summary ? { summary } : {}), ...(type ? { type } : {}), ...(to ? { to } : {}), ...(note ? { note } : {}),
      });
      if (isRefusal(r)) return no(req, reply, r);
      const { warning, ...kept } = r;
      const url = urlOf(who.t, kept.id);
      const rev = kept.revision > 1 ? `  revision ${kept.revision}` : '';
      return answer(req, reply, 201, { artifact: brief(who.t, kept), ...(warning ? { warning } : {}) },
        `put: ${kept.id}${rev}  ${kept.title}  ${kept.type}  ${kept.size} bytes\nurl: ${url}\n${warning ? `warning: ${warning}\n` : ''}`);
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
      if (q(req, 'owner')) {
        made = who.t.artifacts.share(id, { user: { id: who.t.githubProxy.user.id, name: '' } }, by);
      } else if (name) {
        const user = o.tenants.list().find((u) => u.name === name);
        if (!user) return no(req, reply, { status: 404, text: `this hopper has no user ${name}` });
        made = who.t.artifacts.share(id, { user: { id: user.id, name: user.name } }, by);
      } else if (q(req, 'public')) {
        const hours = q(req, 'hours');
        made = who.t.artifacts.share(id, { link: true, ...(hours !== undefined ? { hours: Number(hours) } : {}) }, by);
      } else {
        return no(req, reply, { status: 400, text: 'say who: --owner, --user NAME, --public [--hours N], or --revoke SHARE' });
      }
      if (isRefusal(made)) return no(req, reply, made);
      if ('owner' in made) return shown(req, reply, who, id, by);
      const link = made.token ? `${o.edge.base(who.t)}${LINK_PATH}/${made.token}` : undefined;
      return answer(req, reply, 201, { share: made.share, ...(link ? { link } : {}) }, `shared: ${shareLine(made.share)}${link ? `\nlink: ${link}` : `\nurl: ${urlOf(who.t, id)}`}`);
    });

    scope.get<{ Params: { id: string } }>(`${ARTIFACT_PATH}/:id/revisions`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const a = ID.test(req.params.id) ? who.t.artifacts.get(req.params.id) : undefined;
      if (!a) return no(req, reply, { status: 404, text: `there is no artifact ${req.params.id}` });
      const revs = who.t.artifacts.revisions(a.id);
      return answer(req, reply, 200, { revisions: revs }, revs.map(revisionLine).join('\n'));
    });

    scope.post<{ Params: { id: string } }>(`${ARTIFACT_PATH}/:id/restore`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const n = Number(q(req, 'revision'));
      if (!Number.isInteger(n) || n < 1) return no(req, reply, { status: 400, text: 'name the revision: restore ID N' });
      const r = who.t.artifacts.restore(req.params.id, n, `job ${who.job.id}`);
      if (isRefusal(r)) return no(req, reply, r);
      return answer(req, reply, 200, { artifact: brief(who.t, r) }, `restored: ${r.id}  revision ${n} is revision ${r.revision}, the latest\nurl: ${urlOf(who.t, r.id)}`);
    });

    scope.post<{ Params: { id: string } }>(`${ARTIFACT_PATH}/:id/rm`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who);
      const r = who.t.artifacts.remove(req.params.id, `job ${who.job.id}`);
      return isRefusal(r) ? no(req, reply, r) : answer(req, reply, 200, { removed: r.id }, `removed: ${r.id}  ${r.title}`);
    });
  });
}
