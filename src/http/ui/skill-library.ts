// The skill library (issue #1911, design.md "The skill library"): read every library skill, one skill's version with its
// files, and the choice of work skills; create, edit, duplicate and remove a skill of the user's own, and choose which
// skill each kind of work gets, for every repository or per repository. Each change is an admin's, as the job rules
// are, and each action of POST /ui/api/skill-library is a scope of its own. The next job gets a change, never a running one.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import { WORK_KINDS } from '../../domain/skill-library.ts';
import { changeWorkSkills, duplicateSkill, removeSkill, saveSkill, skillLibraryView, skillView, type LibraryChange } from '../../skill-library/index.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// The name and the files are checked by the library (skillNameProblem, skillFilesProblem).
const name = z.string().min(1).max(100);
const files = z.record(z.string().min(1).max(200), z.string());
export const skillLibraryBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), name, files }),
  z.strictObject({ action: z.literal('edit'), name, files }),
  z.strictObject({ action: z.literal('duplicate'), from: name, version: z.string().min(1).max(64).optional(), name }),
  z.strictObject({ action: z.literal('remove'), name }),
]);

const choice = z.partialRecord(z.enum(WORK_KINDS), name.nullable());
/** Either part: `kinds` for every repository, `repos` per repository (`owner/name`); `null` sets a kind to the next setting down. */
export const workSkillsBody = z.strictObject({
  kinds: choice.optional(),
  repos: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/name').max(200), choice).optional(),
}).refine((b) => b.kinds !== undefined || b.repos !== undefined, { message: 'name kinds or repos' });

const versionQuery = z.strictObject({ version: z.string().min(1).max(64).optional() });

export const SKILL_LIBRARY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/skill-library', tag: 'Skills', summary: 'The skill library', description: 'Issue #1911: every library skill — the built-in ones first, then the user\'s own — with its newest version, without files; the choice of work skills (`workSkills`: `kinds` for every repository, `repos` per repository), the built-in default of each kind of work, and the kinds.', returns: '`SkillLibraryView`' },
  { method: 'get', path: '/api/skill-library/:name', tag: 'Skills', summary: 'A library skill', description: 'One version of a skill with its files — its newest, or the one `version` names, a removed skill\'s too —, and its versions without files.', query: versionQuery, returns: '`{ skill, versions }`', errors: [404] },
  { method: 'post', path: '/ui/api/skill-library', tag: 'Skills', summary: 'Change the skill library', description: '`create` a skill of the user\'s own (`files`: path → text, a `SKILL.md` among them), `edit` it (a new version; the same files keep none), `duplicate` a version of any skill (`from`, `version`) as a new one, or `remove` one of the user\'s own that no work skill setting names. A built-in skill is never edited or removed. Recorded as `library_skill.saved` or `library_skill.removed`.', role: 'admin', body: skillLibraryBody, returns: 'the new `SkillLibraryView`', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/work-skills', tag: 'Skills', summary: 'Choose the work skills', description: 'Which library skill each kind of work (`code`, `research`, `proposal`) gets: `kinds` for every repository, `repos` per repository, which wins; `null` for the next setting down (the built-in default at last). Each skill named must be in the library. Recorded as `work_skills.changed`; the next job gets it.', role: 'admin', body: workSkillsBody, returns: 'the new `SkillLibraryView`', errors: [400, 404] },
];

const STATUS = { invalid: 400, missing: 404, conflict: 409 } as const;
const settled = <T>(r: LibraryChange<T>): T => { if (!r.ok) throw new HttpError(STATUS[r.code], r.error); return r.value; };

export function registerSkillLibraryRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/skill-library', async (req) => skillLibraryView(o.tenant(req).store));
  app.get('/api/skill-library/:name', async (req) => {
    const { version } = parseWith(versionQuery, req.query);
    const skill = (req.params as { name: string }).name;
    const v = skillView(o.tenant(req).store, skill, version);
    if (!v) throw new HttpError(404, `no skill ${skill}${version ? ` at version ${version}` : ''}`);
    return v;
  });
  app.post('/ui/api/skill-library', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the skill library');
    const { store } = o.tenant(req);
    const b = parseWith(skillLibraryBody, req.body);
    const by = personOf(s);
    const now = o.clock.now().toISOString();
    if (b.action === 'create' || b.action === 'edit') settled(saveSkill(store, { mode: b.action, name: b.name, files: b.files, by, now }));
    else if (b.action === 'duplicate') settled(duplicateSkill(store, { from: b.from, ...(b.version ? { version: b.version } : {}), name: b.name, by, now }));
    else settled(removeSkill(store, { name: b.name, by, now }));
    return skillLibraryView(store);
  });
  app.post('/ui/api/work-skills', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to choose the work skills');
    const { store } = o.tenant(req);
    settled(changeWorkSkills(store, parseWith(workSkillsBody, req.body), personOf(s)));
    return skillLibraryView(store);
  });
}
