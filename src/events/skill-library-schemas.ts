// The skill library (issue #1911, design.md "The skill library"): a library skill's version kept or the skill removed,
// the choice of work skills changed, and the work skill a job got. Part of EVENT_SCHEMAS (schemas.ts), with its docs
// (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { WORK_KINDS } from '../domain/skill-library.ts';

const kind = z.enum(WORK_KINDS);
const choice = z.partialRecord(kind, z.string());
const settings = z.strictObject({ kinds: choice, repos: z.record(z.string(), choice) });
const source = z.union([
  z.strictObject({ kind: z.literal('built-in') }), z.strictObject({ kind: z.literal('created') }),
  z.strictObject({ kind: z.literal('duplicated'), name: z.string(), version: z.string() }),
  z.strictObject({ kind: z.literal('imported'), repo: z.string(), path: z.string(), ref: z.string(), commit: z.string() }),
]);

export const SKILL_LIBRARY_EVENT_SCHEMAS = {
  'library_skill.saved': z.strictObject({ name: z.string(), version: z.string(), seq: z.number().int(), source, by: z.string() }),
  'library_skill.removed': z.strictObject({ name: z.string(), by: z.string() }),
  'library_skill.refreshed': z.strictObject({ name: z.string(), repo: z.string(), path: z.string(), ref: z.string(), commit: z.string(), version: z.string(), changed: z.boolean(), by: z.string() }),
  'work_skills.changed': z.strictObject({ from: settings, to: settings, by: z.string() }),
  'job.work_skill_chosen': z.strictObject({ kind, name: z.string(), version: z.string(), seq: z.number().int(), from: z.enum(['repo', 'user', 'default']) }),
} as const;

/** Its part of the event reference (docs.ts). */
export const SKILL_LIBRARY_EVENT_DOCS = {
  'library_skill.saved': 'A person kept a new version of a library skill (issue #1911): `name`, its content id `version` and its place `seq` (1, 2, …); `source` says whether a person wrote it (`created`) copied it from another skill\'s version (`duplicated`, with that `name` and `version`), or imported it from a folder of a GitHub repository (`imported`: `repo`, the folder `path` — empty: the root —, the `ref` it follows, the `commit` read). Never its files: GET /api/skill-library/{name} answers them.',
  'library_skill.removed': 'A person removed a library skill of their own (issue #1911): no list shows it, and no new job gets it. Jobs that got one of its versions keep it.',
  'library_skill.refreshed': 'A person refreshed an imported library skill (issue #1911): its folder `path` of `repo` read again at the `ref` it follows, at `commit`. `changed`: the files differ from its newest version, so `version` is a new version (and a `library_skill.saved` beside it); else `version` is the one it had.',
  'work_skills.changed': 'A person changed which library skill each kind of work gets (issue #1911): `kinds` for every repository, `repos` per repository (`owner/name` lowercased), which wins; a kind absent gets the built-in default. `from` and `to`. The next job gets it, never a running one.',
  'job.work_skill_chosen': 'The work skill this job got (issue #1911), at its first start or when its kind of work changed: its kind of work (`code`, `research`, `proposal`), the skill `name`, its `version` and `seq` (0: built in), and which setting chose it (`repo`, `user`, `default`). Each later start of the job, on any machine, gets the same version.',
} as const;

/** Its examples (examples.ts). */
export const SKILL_LIBRARY_EVENT_EXAMPLES = {
  'library_skill.saved': { name: 'careful-work', version: '3f9c2a7b1d4e6f80', seq: 2, source: { kind: 'created' }, by: 'owner' },
  'library_skill.removed': { name: 'careful-work', by: 'owner' },
  'library_skill.refreshed': { name: 'orchestrate', repo: 'owner/workflows', path: 'skills/orchestrate', ref: 'HEAD', commit: '9b2e4c7d1a3f5e6b8c0d2f4a6b8c0e2d4f6a8b0c', version: '7c1e3a5b9d2f4e60', changed: true, by: 'owner' },
  'work_skills.changed': { from: { kinds: {}, repos: {} }, to: { kinds: { code: 'careful-work' }, repos: { 'owner/repo': { research: 'research' } } }, by: 'owner' },
  'job.work_skill_chosen': { kind: 'code', name: 'careful-work', version: '3f9c2a7b1d4e6f80', seq: 2, from: 'user' },
} as const;
