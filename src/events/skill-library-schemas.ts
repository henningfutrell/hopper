// The skill library (issue #1911, design.md "The skill library"): a library skill's version kept or the skill removed,
// the choice of work skills changed, and the work skill a job got. Part of EVENT_SCHEMAS (schemas.ts), with its docs
// (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { WORK_KINDS } from '../domain/skill-library.ts';

const kind = z.enum(WORK_KINDS);
const choice = z.partialRecord(kind, z.string());
const rule = z.strictObject({ skill: z.string(), repos: z.array(z.string()).optional(), labels: z.array(z.string()).optional(), kinds: z.array(kind).optional(), paths: z.array(z.string()).optional() });
const settings = z.strictObject({ kinds: choice, repos: z.record(z.string(), choice), rules: z.array(rule).optional() });
const criterion = z.union([
  z.strictObject({ kind: z.literal('checks-passed'), checks: z.string() }),
  z.strictObject({ kind: z.literal('plan-destroy'), checks: z.string().optional(), max: z.number().int().optional() }),
  z.strictObject({ kind: z.literal('person-merges'), paths: z.array(z.string()).optional() }),
]);
const conditional = z.strictObject({ name: z.string(), version: z.string(), seq: z.number().int(), why: z.array(z.string()), done: z.array(criterion), paths: z.array(z.string()).optional() });
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
  'job.work_skill_chosen': z.strictObject({
    kind, name: z.string(), version: z.string(), seq: z.number().int(), from: z.enum(['repo', 'user', 'default']),
    requires: z.array(z.strictObject({ name: z.string(), version: z.string(), seq: z.number().int() })).optional(), missing: z.array(z.string()).optional(),
  }),
  'job.conditional_skills_chosen': z.strictObject({ skills: z.array(conditional) }),
} as const;

/** Its part of the event reference (docs.ts). */
export const SKILL_LIBRARY_EVENT_DOCS = {
  'library_skill.saved': 'A person kept a new version of a library skill (issue #1911): `name`, its content id `version` and its place `seq` (1, 2, …); `source` says whether a person wrote it (`created`) copied it from another skill\'s version (`duplicated`, with that `name` and `version`), or imported it from a folder of a GitHub repository (`imported`: `repo`, the folder `path` — empty: the root —, the `ref` it follows, the `commit` read). Never its files: GET /api/skill-library/{name} answers them.',
  'library_skill.removed': 'A person removed a library skill of their own (issue #1911): no list shows it, and no new job gets it. Jobs that got one of its versions keep it.',
  'library_skill.refreshed': 'A person refreshed an imported library skill (issue #1911): its folder `path` of `repo` read again at the `ref` it follows, at `commit`. `changed`: the files differ from its newest version, so `version` is a new version (and a `library_skill.saved` beside it); else `version` is the one it had.',
  'work_skills.changed': 'A person changed which library skill each kind of work gets (issue #1911): `kinds` for every repository, `repos` per repository (`owner/name` lowercased), which wins; a kind absent gets the built-in default; `rules`, the skill rules that give a job conditional skills (issue #1924; a rule\'s `paths`, part 2, are globs of the files the change touches), absent with none. `from` and `to`. The next job gets it, never a running one.',
  'job.work_skill_chosen': 'The work skill this job got (issue #1911), at its first start or when its kind of work changed: its kind of work (`code`, `research`, `proposal`), the skill `name`, its `version` and `seq` (0: built in), and which setting chose it (`repo`, `user`, `default`). `requires`: the skills it got beside it because the work skill, or a skill it requires, names them in its SKILL.md\'s `requires:` — each `name`, `version` and `seq`; `missing`: the ones required that it did not get (not in the library, or past the limit of 8). Both absent on a choice made before skills required others. Each later start of the job, on any machine, gets the same versions.',
  'job.conditional_skills_chosen': 'The conditional skills this job got beside its work skill (issue #1924), at its first start, because a skill rule matched what it works on: each skill\'s `name`, `version` and `seq` (0: built in), `why` (the conditions that matched: `repository owner/name`, `label x`, `kind of work k`, `paths a, b`), and `done`, the done criteria of its `done.json` that the done check verifies before the job is done (part 3: `person-merges`, a person merges a change to its `paths`, never the hopper\'s yolo mode, which reads the criteria again before its merge). `paths` (part 2): the globs of a paths rule; the done check verifies the criteria only when the pull request changes a file they match. Absent: always. Each later start gets the same versions. None when no rule matched.',
} as const;

/** Its examples (examples.ts). */
export const SKILL_LIBRARY_EVENT_EXAMPLES = {
  'library_skill.saved': { name: 'careful-work', version: '3f9c2a7b1d4e6f80', seq: 2, source: { kind: 'created' }, by: 'owner' },
  'library_skill.removed': { name: 'careful-work', by: 'owner' },
  'library_skill.refreshed': { name: 'workflow-orchestrate', repo: 'owner/workflows', path: 'skills/workflow-orchestrate', ref: 'HEAD', commit: '9b2e4c7d1a3f5e6b8c0d2f4a6b8c0e2d4f6a8b0c', version: '7c1e3a5b9d2f4e60', changed: true, by: 'owner' },
  'work_skills.changed': { from: { kinds: {}, repos: {} }, to: { kinds: { code: 'careful-work' }, repos: { 'owner/repo': { research: 'research' } } }, by: 'owner' },
  'job.work_skill_chosen': { kind: 'code', name: 'careful-work', version: '3f9c2a7b1d4e6f80', seq: 2, from: 'user', requires: [{ name: 'work', version: '8a1d3c5e7f9b2d40', seq: 0 }], missing: [] },
  'job.conditional_skills_chosen': { skills: [{ name: 'iac', version: '9a1c3e5f7b2d4068', seq: 0, why: ['repository owner/infra'], done: [{ kind: 'checks-passed', checks: 'terraform plan*' }, { kind: 'plan-destroy', checks: 'terraform plan*' }] }] },
} as const;
