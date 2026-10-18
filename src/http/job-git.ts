// Git through the hopper's route (issue #652, design.md "Git through the hopper"): a running job's git — not a person
// — fetches and pushes through the hopper, outside the UI session, on the hopper's own URL and behind the Host guard,
// like the GitHub proxy (job-github.ts).
//
//   GET  /job/git/<owner>/<name>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /job/git/<owner>/<name>.git/git-upload-pack|git-receive-pack
//                      git's smart HTTP; Basic auth whose password is the job's proxy token. The hopper does it on
//                      GitHub with the job's own user's connection, or answers why not. It changes no job, question,
//                      webhook or setting; a push is recorded on the job's timeline.
//   GET  /job/gitlab-git/<project>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /job/gitlab-git/<project>.git/git-upload-pack|git-receive-pack
//                      the same for a job of a GitLab issue (issue #1448 part 3), done on GitLab with the token of the job's
//                      own user's GitLab account; a push only to the job's own project.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createGitProxy, GIT_PATH, type GitAnswer, type GitPushes, type GitRequest } from '../github-proxy/index.ts';
import { createGitLabGitProxy, GITLAB_GIT_PATH } from '../gitlab/git-broker.ts';
import type { Tenants } from './tenants.ts';

/** The most a job's push or fetch request may carry. */
export const GIT_BODY_LIMIT = 512 * 1024 * 1024;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function jobGitRoutes(app: FastifyInstance, o: { tenants: Tenants; pushes?: GitPushes }): void {
  const proxy = createGitProxy({ user: (id) => o.tenants.user(id)?.githubProxy.git, log: (line) => console.warn(line), ...(o.pushes ? { pushes: o.pushes } : {}) });
  const gitlab = createGitLabGitProxy({
    user: (id) => { const t = o.tenants.user(id); return t && { user: t.githubProxy.user, gitlab: t.gitlabAccount }; },
    log: (line) => console.warn(line),
  });
  const send = (reply: FastifyReply, a: GitAnswer) => reply.code(a.status).headers(a.headers).send(a.body);
  const asked = (req: FastifyRequest): GitRequest => {
    const q = req.query as Record<string, string | undefined>;
    return {
      method: req.method, path: (req.params as { '*': string })['*'], ...(req.method === 'GET' && q.service ? { service: q.service } : {}),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(req.method === 'POST' && req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
      ...(req.method === 'POST' && one(req.headers['content-encoding']) ? { contentEncoding: one(req.headers['content-encoding'])! } : {}),
      ...(one(req.headers['git-protocol']) ? { gitProtocol: one(req.headers['git-protocol'])! } : {}),
      ...(req.method === 'POST' && Buffer.isBuffer(req.body) ? { body: req.body } : {}),
    };
  };
  void app.register(async (scope) => {
    // git's request bodies, read whole: a push's ref updates are checked before anything reaches GitHub or GitLab.
    for (const type of ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request']) {
      scope.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: GIT_BODY_LIMIT }, (_req, body, done) => { done(null, body); });
    }
    for (const [path, broker] of [[GIT_PATH, proxy], [GITLAB_GIT_PATH, gitlab]] as const) {
      scope.get(`${path}*`, async (req, reply) => send(reply, await broker.handle(asked(req))));
      scope.post(`${path}*`, async (req, reply) => send(reply, await broker.handle(asked(req))));
    }
  });
}
