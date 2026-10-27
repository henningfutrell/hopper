// Repository memory (issue #2847, design.md "Repository memory"): the memory entries jobs learned of each repository, and a
// person's acts on them — add, edit, approve, disable, enable, remove —; and the settings record `repo-memory`, replaced
// whole against the version read. An entry is text every job of its repository is told, as the repository job rules are:
// least role to change, admin. `hopper memory` posts here.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MEMORY_KINDS, type RepoMemoryView } from '../../domain/repo-memory.ts';
import { actOnMemory, memoryView, writeMemorySettings } from '../../repo-memory/index.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const kind = z.enum(MEMORY_KINDS);
const id = { id: z.string().min(1) };
export const repoMemoryQuery = z.object({ repo: z.string().optional() });
// The fields are checked by memoryEntryProblem when they are kept.
export const repoMemoryBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), repo: z.string(), kind, area: z.string().optional(), text: z.string() }),
  z.strictObject({ action: z.literal('edit'), ...id, kind: kind.optional(), area: z.string().nullable().optional(), text: z.string().optional() }),
  z.strictObject({ action: z.literal('approve'), ...id }),
  z.strictObject({ action: z.literal('disable'), ...id }),
  z.strictObject({ action: z.literal('enable'), ...id }),
  z.strictObject({ action: z.literal('remove'), ...id }),
]);
// The settings are checked by memorySettingsProblem when they are written.
export const repoMemorySettingsBody = z.strictObject({ settings: z.unknown(), version: z.string().min(1) });

export const REPO_MEMORY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/repo-memory', tag: 'Jobs', summary: 'The repository memory', description: 'Issue #2847: the memory entries of `repo` (`owner/name`; absent: of every repository), newest change first — each its kind (`convention`, `fix`), area, text, state (`proposed`, `approved`, `disabled`, `flagged`), confidence, source job and times, and `expired` when it is too old to be offered —; the settings with their defaults, and the settings record\'s `version`. `hopper memory list` reads it.', query: repoMemoryQuery, returns: '`RepoMemoryView`' },
  { method: 'post', path: '/ui/api/repo-memory', tag: 'Jobs', summary: 'Add, edit, approve, disable, enable or remove a memory entry', description: 'Issue #2847. `add` (`repo` `owner/name`, `kind`, `area` a path, `text` one line of at most 1000 characters): approved at once, confidence 1 (409: the repository has it, or has 200). `edit` (`id` or its short id, and `kind`, `area` — null takes it away —, `text`): renews its age and clears a flag. `approve`: a proposed, flagged or expired entry is offered again. `disable`, `enable`: out of use, and back. `remove`. Each is `repo_memory.changed`; the next job of the repository gets it. 404: no such entry. `hopper memory` posts here.', role: 'admin', body: repoMemoryBody, returns: '`{ entry: MemoryEntry }`, `{ removed: true }` for `remove`', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/repo-memory/settings', tag: 'Jobs', summary: 'Replace the repository memory settings', description: 'Issue #2847. `settings`: `on` and `approval` (defaults true, true), `maxBytes` (256 to 16384, default 4096: what one job is told), `expireDays` (1 to 3650, default 180), and `repos` — `owner/name` or `owner/*` to its own `on` and `approval` —, against the `version` read from GET /api/repo-memory.', role: 'admin', body: repoMemorySettingsBody, returns: '`{ settings: MemorySettings, version }`', errors: [400, 409] },
];

const SETTINGS_STATUS = { invalid: 400, conflict: 409 } as const;

export function registerRepoMemoryRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: { now(): Date } }): void {
  app.get('/api/repo-memory', async (req): Promise<RepoMemoryView> => {
    const { repo } = parseWith(repoMemoryQuery, req.query);
    return memoryView(o.tenant(req).store, repo, o.clock.now());
  });
  app.post('/ui/api/repo-memory', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the repository memory');
    const b = parseWith(repoMemoryBody, req.body);
    const act = b.action === 'add' ? { ...b, ...(b.area === undefined ? {} : { area: b.area }) } : b;
    const r = actOnMemory(o.tenant(req).store, act as Parameters<typeof actOnMemory>[1], personOf(s), o.clock.now().toISOString(), randomUUID);
    if ('no' in r) throw new HttpError(r.status, r.no);
    return r;
  });
  app.post('/ui/api/repo-memory/settings', o.admin, async (req) => {
    const { settings, version } = parseWith(repoMemorySettingsBody, req.body);
    const r = writeMemorySettings(o.tenant(req).store, settings, version);
    if (!r.ok) throw new HttpError(SETTINGS_STATUS[r.code], r.error);
    return { settings: r.settings, version: r.version };
  });
}
