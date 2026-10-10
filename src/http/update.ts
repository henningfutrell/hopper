// Self-update, read side (design.md "Self-update"): what is installed, what is newer, how an apply stands,
// and the version history of the installed commit. The compose file this build ships with and the agent update skill
// (issue #697): what an update of a container install puts in, and how an agent does it.
import type { FastifyInstance } from 'fastify';
import type { Updater } from '../domain/ports.ts';
import type { Operation } from './openapi-operation.ts';
import { BUILD_DIR, readShippedCompose } from '../update/shipped-compose.ts';
import { UPDATE_SKILL } from '../update/update-skill.ts';

/** Self-update's part of the API reference (src/http/openapi.ts). */
export const UPDATE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/update', tag: 'Self-update', summary: 'Installed version and available update', returns: '`UpdateStatus`' },
  { method: 'get', path: '/api/update/history', tag: 'Self-update', summary: 'Version history', description: 'The versions the installed commit is made of, newest first: each commit of the tracked branch (first parent) that added What\'s new lines, with its date and those lines. Checks the update repository first when it lacks the installed commit. Always carries `build`: what the running build\'s install.json says (an install or an image), whole or not; `reason` names what it lacks.', returns: '`VersionHistory`' },
  { method: 'get', path: '/api/update/compose', tag: 'Self-update', summary: 'The compose file this build ships with', description: 'Issue #697: the compose.yaml of this build\'s commit, its first line the version stamp (`# hopper version: <branch> <commit>`), with the branch and commit of install.json. An update of a container install puts in the compose file of the image it updates to: `hopper update <tool>`, run from that image. 404 when this build ships none.', returns: '`ShippedCompose`', errors: [404] },
  { method: 'get', path: '/api/update/skill', tag: 'Self-update', summary: 'The agent update skill', description: 'Issue #697: the steps an agent follows to update a container hopper, as Markdown: the compose file of the image it updates to, the whole stack, never the hopper service alone. `hopper update skill` prints the same.', answers: 'markdown', returns: 'Markdown' },
];

export function updateRoutes(app: FastifyInstance, o: { updater: Updater; buildDir?: string }): void {
  app.get('/api/update', async () => o.updater.status());
  app.get('/api/update/history', async () => o.updater.history());
  app.get('/api/update/compose', async (_req, reply) => {
    const r = readShippedCompose(o.buildDir ?? BUILD_DIR);
    return r.ok ? r.shipped : reply.code(404).send({ error: r.reason });
  });
  app.get('/api/update/skill', async (_req, reply) => reply.type('text/markdown; charset=utf-8').send(UPDATE_SKILL));
}
