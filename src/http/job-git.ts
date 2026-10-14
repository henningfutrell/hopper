// Git through the hopper's route (issue #652, design.md "Git through the hopper"): a running job's git — not a person
// — fetches and pushes through the hopper, outside the UI session, on the hopper's own URL and behind the Host guard,
// like the GitHub proxy (job-github.ts).
//
//   GET  /job/git/<owner>/<name>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /job/git/<owner>/<name>.git/git-upload-pack|git-receive-pack
//                      git's smart HTTP; Basic auth whose password is the job's proxy token. The hopper does it on
//                      GitHub with the job's own user's connection, or answers why not. It changes no job, question,
//                      webhook or setting; a push is recorded on the job's timeline.
import type { FastifyInstance } from 'fastify';
import { createGitProxy, GIT_PATH, type GitAnswer } from '../github-proxy/index.ts';
import type { Tenants } from './tenants.ts';

/** The most a job's push or fetch request may carry. */
export const GIT_BODY_LIMIT = 512 * 1024 * 1024;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function jobGitRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  const proxy = createGitProxy({ user: (id) => o.tenants.user(id)?.githubProxy.git, log: (line) => console.warn(line) });
  const send = (reply: { code(n: number): { headers(h: Record<string, string>): { send(b: unknown): unknown } } }, a: GitAnswer) =>
    reply.code(a.status).headers(a.headers).send(a.body);
  void app.register(async (scope) => {
    // git's request bodies, read whole: a push's ref updates are checked before anything reaches GitHub.
    for (const type of ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request']) {
      scope.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: GIT_BODY_LIMIT }, (_req, body, done) => { done(null, body); });
    }
    scope.get(`${GIT_PATH}*`, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      return send(reply, await proxy.handle({
        method: 'GET', path: (req.params as { '*': string })['*'], ...(q.service ? { service: q.service } : {}),
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(one(req.headers['git-protocol']) ? { gitProtocol: one(req.headers['git-protocol'])! } : {}),
      }));
    });
    scope.post(`${GIT_PATH}*`, async (req, reply) => send(reply, await proxy.handle({
      method: 'POST', path: (req.params as { '*': string })['*'],
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
      ...(one(req.headers['content-encoding']) ? { contentEncoding: one(req.headers['content-encoding'])! } : {}),
      ...(one(req.headers['git-protocol']) ? { gitProtocol: one(req.headers['git-protocol'])! } : {}),
      ...(Buffer.isBuffer(req.body) ? { body: req.body } : {}),
    })));
  });
}
