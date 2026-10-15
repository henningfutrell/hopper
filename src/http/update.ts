// Self-update, read side (design.md "Self-update"): what is installed, what is newer, how an apply stands,
// and the version history of the installed commit. The compose file this build ships with and the agent update skill
// (issue #697): what an update of a container install puts in, and how an agent does it; and how the stack differs from it.
import type { FastifyInstance } from 'fastify';
import type { Updater } from '../domain/ports.ts';
import type { ClusterInstall, StackDrift } from '../domain/types.ts';
import type { Operation } from './openapi-operation.ts';
import { BUILD_DIR, readShippedCompose } from '../update/shipped-compose.ts';
import { updateSkill } from '../update/update-skill.ts';

/** Self-update's part of the API reference (src/http/openapi.ts). */
export const UPDATE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/update', tag: 'Self-update', summary: 'Installed version and available update', description: 'Issue #652: `available` only when the channel\'s head is the merge of a pull request whose checks passed (`target.pullRequest`, asked of GitHub); else `held`, with `reason`: not offered, announced or applied.', returns: '`UpdateStatus`' },
  { method: 'get', path: '/api/update/history', tag: 'Self-update', summary: 'Version history', description: 'The versions the installed commit is made of, newest first: each commit of the tracked branch (first parent) that added What\'s new lines, with its date and those lines. Checks the update repository first when it lacks the installed commit. Always carries `build`: what the running build\'s install.json says (an install or an image), whole or not; `reason` names what it lacks.', returns: '`VersionHistory`' },
  { method: 'get', path: '/api/update/compose', tag: 'Self-update', summary: 'The compose file this build ships with', description: 'Issue #697: the compose.yaml of this build\'s commit, its first line the version stamp (`# hopper version: <branch> <commit>`), with the branch and commit of install.json. An update of a container install puts in the compose file of the image it updates to: `hopper update <tool>`, run from that image. 404 when this build ships none, or for a cluster install (issue #1285).', returns: '`ShippedCompose`', errors: [404] },
  { method: 'get', path: '/api/update/drift', tag: 'Self-update', summary: 'How the stack differs from the compose file of this version', description: 'Issue #697: a container hopper compares the stack it runs in with the compose file its image ships with — each service that must run (by its name on the compose network), the settings the file gives the hopper\'s container, and the version of the vault in its own container. Each gap names what it turns off; `image` is the image the fix, the update commands, names. `unchecked` with the reason for an install that is not an image, or a build that ships no compose file. A cluster install (issue #1285, `cluster` set) compares the image it runs with the update channel instead, a gap of kind `image`; its fix is `helm upgrade` of the release to `image`.', returns: '`StackDrift`' },
  { method: 'get', path: '/api/update/skill', tag: 'Self-update', summary: 'The agent update skill', description: 'Issue #697: the steps an agent follows to update a container hopper, as Markdown: the compose file of the image it updates to, the whole stack, never the hopper service alone; for a cluster install (issue #1285), `helm upgrade` of its release. `hopper update skill` prints the same.', answers: 'markdown', returns: 'Markdown' },
];

export function updateRoutes(app: FastifyInstance, o: { updater: Updater; buildDir?: string; stackDrift?: () => Promise<StackDrift>; cluster?: ClusterInstall | undefined }): void {
  app.get('/api/update', async () => o.updater.status());
  app.get('/api/update/history', async () => o.updater.history());
  app.get('/api/update/compose', async (_req, reply) => {
    // A cluster install (issue #1285) runs no compose file: none is offered to put in.
    if (o.cluster) return reply.code(404).send({ error: 'a cluster install runs no compose file: update it with helm upgrade of its release' });
    const r = readShippedCompose(o.buildDir ?? BUILD_DIR);
    return r.ok ? r.shipped : reply.code(404).send({ error: r.reason });
  });
  app.get('/api/update/drift', async (): Promise<StackDrift> => (o.stackDrift ? o.stackDrift() : { state: 'unchecked', reason: 'not checked here', gaps: [] }));
  app.get('/api/update/skill', async (_req, reply) => reply.type('text/markdown; charset=utf-8').send(updateSkill(o.cluster)));
}
