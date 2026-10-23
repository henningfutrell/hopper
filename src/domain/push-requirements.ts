// Push requirements (issue #2555, design.md "Push requirements"): the checks a job runs in its work tree before it pushes,
// so a CI gate that would fail — the changed-files coverage gate, the migration tests — fails here first. Each is a rule:
// a condition on the push (the files it changes, its repository, branch and base, the job's kind of work and labels), the
// checks to run, and their pass criteria (the exit code, and thresholds on what a check measures). A repository keeps them
// in `.hopper/requirements.yaml`; one in a folder's `.hopper/` is path-scoped. A requirement with the same id at a higher
// level replaces the lower one: the job's override, a path-scoped one, the repository's, the hopper's default. Pure.
import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { globMatches } from './conditional-skills.ts';
import { WORK_KINDS, type WorkKind } from './skill-library.ts';

/** The repository's requirements file; the same name under a folder is that folder's (path-scoped). */
export const REQUIREMENTS_FILE = '.hopper/requirements.yaml';
/** A check says what it measured on a line of its output: `hopper-measure <name>=<number>`. */
export const MEASURE_PREFIX = 'hopper-measure';

/** The levels a requirement comes from, lowest first: a higher one replaces a lower one of the same id. */
export const REQUIREMENT_LEVELS = ['default', 'repo', 'path', 'job'] as const;
export type RequirementLevel = typeof REQUIREMENT_LEVELS[number];

export type RequirementCondition =
  | { all: RequirementCondition[] } | { any: RequirementCondition[] } | { not: RequirementCondition }
  | { paths: string[] } | { fileTypes: string[] } | { repos: string[] } | { branches: string[] } | { bases: string[] }
  | { kinds: WorkKind[] } | { labels: string[] } | { dependencies: true } | { workflows: true };

export interface Threshold { min?: number; max?: number }
export interface RequirementCheck {
  name: string;
  /** A shell command (`sh -c`), run at the top of the work tree, or in its folder for a path-scoped requirement. */
  run: string;
  env?: Record<string, string>;
  /** The values the check must measure, and their bounds; each is also given to it as `HOPPER_MIN_<name>`, `HOPPER_MAX_<name>`. */
  thresholds?: Record<string, Threshold>;
  /** The CI check it stands for (part 5, push-requirement-metrics.ts): globs of CI check names, and the billed minutes of a CI run that fails on it. */
  ci?: CiCheck;
}
export interface CiCheck { checks: string[]; minutes?: number }
export interface PushRequirement { id: string; when?: RequirementCondition; checks: RequirementCheck[] }
/** A requirement as it applies: where it came from, and the folder of a path-scoped one. */
export interface EffectiveRequirement extends PushRequirement { level: RequirementLevel; dir?: string }

/** What a push's requirements are judged on. */
export interface PushContext { files: readonly string[]; repo: string; branch: string; base: string; kind: WorkKind; labels: readonly string[] }

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MEASURE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const relativeGlob = z.string().min(1).refine((g) => !g.startsWith('/') && !g.split('/').includes('..'), { message: 'a path glob is relative, with no ..' });
const words = z.array(z.string().min(1)).min(1);
const condition: z.ZodType<RequirementCondition> = z.lazy(() => z.union([
  z.strictObject({ all: z.array(condition).min(1) }), z.strictObject({ any: z.array(condition).min(1) }), z.strictObject({ not: condition }),
  z.strictObject({ paths: z.array(relativeGlob).min(1) }), z.strictObject({ fileTypes: words }), z.strictObject({ repos: words }),
  z.strictObject({ branches: words }), z.strictObject({ bases: words }), z.strictObject({ kinds: z.array(z.enum(WORK_KINDS)).min(1) }),
  z.strictObject({ labels: words }), z.strictObject({ dependencies: z.literal(true) }), z.strictObject({ workflows: z.literal(true) }),
]));
const threshold = z.strictObject({ min: z.number().optional(), max: z.number().optional() }).refine((t) => t.min !== undefined || t.max !== undefined, { message: 'a threshold names min or max' });
const check = z.strictObject({
  name: z.string().min(1).max(200), run: z.string().min(1),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  thresholds: z.record(z.string().regex(MEASURE, { message: 'a measure is a name of letters, digits and _' }), threshold).optional(),
  ci: z.strictObject({ checks: words, minutes: z.number().positive().optional() }).optional(),
});
const requirement = z.strictObject({
  id: z.string().regex(ID, { message: 'an id is lowercase letters, digits, ., _ and -' }),
  when: condition.optional(), checks: z.array(check).min(1, { message: 'a requirement names at least one check' }),
});
/** A requirements file's value, and the hopper's default requirements (a user setting): `{ requirements: [...] }`. */
export const requirementsFileSchema = z.strictObject({ requirements: z.array(requirement) });

/** A requirements file's text read, or why it cannot be. */
export function parseRequirements(text: string): { ok: true; requirements: PushRequirement[] } | { ok: false; problem: string } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) { return { ok: false, problem: `it is not YAML: ${(e as Error).message.split('\n')[0]}` }; }
  return readRequirements(raw);
}

/** A requirements file's value, as YAML or JSON gives it, read; or why it cannot be. */
export function readRequirements(raw: unknown): { ok: true; requirements: PushRequirement[] } | { ok: false; problem: string } {
  const r = requirementsFileSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const at = i.path.length > 0 ? ` at ${i.path.join('.')}` : '';
    const id = Array.isArray((raw as { requirements?: unknown })?.requirements) && typeof i.path[1] === 'number' ? (raw as { requirements: { id?: unknown }[] }).requirements[i.path[1]]?.id : undefined;
    return { ok: false, problem: `${i.message}${at}${typeof id === 'string' ? ` (requirement ${JSON.stringify(id)})` : ''}; a requirements file is { requirements: [{ id, when, checks }] }` };
  }
  const twice = r.data.requirements.find((q, n) => r.data.requirements.findIndex((o) => o.id === q.id) !== n);
  if (twice) return { ok: false, problem: `the id ${twice.id} is named twice` };
  return { ok: true, requirements: r.data.requirements as PushRequirement[] };
}

/** The folder whose requirements a file at `path` holds (`''`: the repository's own), or undefined: it is no requirements file. */
export function requirementsFileDir(path: string): string | undefined {
  if (path === REQUIREMENTS_FILE) return '';
  return path.endsWith(`/${REQUIREMENTS_FILE}`) ? path.slice(0, -REQUIREMENTS_FILE.length - 1) : undefined;
}

/** Where a push's requirements come from, at each level. */
export interface RequirementsAt {
  defaults?: readonly PushRequirement[];
  repo?: readonly PushRequirement[];
  scoped?: readonly { dir: string; requirements: readonly PushRequirement[] }[];
  job?: readonly PushRequirement[];
}

/** The requirements that apply: by id, the highest level's; in the order each id first appears, lowest level first. */
export function effectiveRequirements(at: RequirementsAt): EffectiveRequirement[] {
  const byId = new Map<string, EffectiveRequirement>();
  const put = (q: EffectiveRequirement) => { byId.set(q.id, q); };
  for (const q of at.defaults ?? []) put({ ...q, level: 'default' });
  for (const q of at.repo ?? []) put({ ...q, level: 'repo' });
  // A deeper folder's replaces a shallower one's.
  for (const s of [...(at.scoped ?? [])].sort((a, b) => a.dir.split('/').length - b.dir.split('/').length)) {
    for (const q of s.requirements) {
      const inDir: RequirementCondition = { paths: [`${s.dir}/**`] };
      put({ ...q, when: q.when ? { all: [inDir, q.when] } : inDir, level: 'path', dir: s.dir });
    }
  }
  for (const q of at.job ?? []) put({ ...q, level: 'job' });
  return [...byId.values()];
}

/** Dependency manifests and lock files, by file name. */
const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'gradle.lockfile', 'libs.versions.toml', 'pom.xml', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'uv.lock', 'Gemfile', 'Gemfile.lock', 'composer.json',
  'composer.lock', 'packages.lock.json', 'Directory.Packages.props', 'mix.exs', 'mix.lock',
]);
const isManifest = (f: string): boolean => MANIFESTS.has(posix.basename(f)) || /\.(csproj|fsproj)$/.test(f);
const isWorkflow = (f: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f);

const quoted = (vs: readonly string[]): string => vs.map((v) => `\`${v}\``).join(', ');
const some = (fs: readonly string[]): string => `${fs.slice(0, 3).join(', ')}${fs.length > 3 ? ` and ${fs.length - 3} more` : ''}`;
const anyCase = (vs: readonly string[], v: string): boolean => vs.some((x) => x.toLowerCase() === v.toLowerCase());
const oneOf = (what: string, v: string, vs: readonly string[], holds: boolean): string =>
  holds ? `the ${what} ${v} is one of ${quoted(vs)}` : `the ${what} ${v} is ${vs.length === 1 ? 'not' : 'none of'} ${quoted(vs)}`;
const filesThat = (files: readonly string[], test: (f: string) => boolean, yes: string, no: string): { holds: boolean; why: string } => {
  const hit = files.filter(test);
  return hit.length > 0 ? { holds: true, why: `${yes}: ${some(hit)}` } : { holds: false, why: no };
};

/** Whether `c` holds for the push, and why it does or does not, in words. */
export function conditionHolds(c: RequirementCondition, ctx: PushContext): { holds: boolean; why: string } {
  if ('all' in c) {
    const each = c.all.map((x) => conditionHolds(x, ctx));
    const failed = each.find((x) => !x.holds);
    return failed ? { holds: false, why: failed.why } : { holds: true, why: each.map((x) => x.why).join('; and ') };
  }
  if ('any' in c) {
    const each = c.any.map((x) => conditionHolds(x, ctx));
    const held = each.find((x) => x.holds);
    return held ? { holds: true, why: held.why } : { holds: false, why: each.map((x) => x.why).join('; and ') };
  }
  if ('not' in c) { const x = conditionHolds(c.not, ctx); return { holds: !x.holds, why: `not: ${x.why}` }; }
  if ('paths' in c) return filesThat(ctx.files, (f) => c.paths.some((g) => globMatches(g, f)), `changed files match ${quoted(c.paths)}`, `no changed files match ${quoted(c.paths)}`);
  if ('fileTypes' in c) {
    const types = c.fileTypes.map((t) => (t.startsWith('.') ? t : `.${t}`).toLowerCase());
    const named = types.join(', ');
    return filesThat(ctx.files, (f) => types.includes(posix.extname(f).toLowerCase()), `changed files of type ${named}`, `no changed files of type ${named}`);
  }
  if ('repos' in c) { const holds = anyCase(c.repos, ctx.repo); return { holds, why: oneOf('repository', ctx.repo, c.repos, holds) }; }
  if ('branches' in c) { const holds = c.branches.some((g) => posix.matchesGlob(ctx.branch, g)); return { holds, why: oneOf('branch', ctx.branch, c.branches, holds) }; }
  if ('bases' in c) { const holds = c.bases.some((g) => posix.matchesGlob(ctx.base, g)); return { holds, why: oneOf('base', ctx.base, c.bases, holds) }; }
  if ('kinds' in c) { const holds = c.kinds.includes(ctx.kind); return { holds, why: oneOf('kind of work', ctx.kind, c.kinds, holds) }; }
  if ('labels' in c) {
    const label = ctx.labels.find((l) => anyCase(c.labels, l));
    return label !== undefined ? { holds: true, why: oneOf('label', label, c.labels, true) } : { holds: false, why: `no label is one of ${quoted(c.labels)}` };
  }
  if ('dependencies' in c) return filesThat(ctx.files, isManifest, 'a dependency manifest changed', 'no dependency manifest changed');
  return filesThat(ctx.files, isWorkflow, 'a workflow file changed', 'no workflow file changed');
}

export interface PlannedRequirement { id: string; level: RequirementLevel; dir?: string; why: string; checks: RequirementCheck[] }
export interface SkippedRequirement { id: string; level: RequirementLevel; reason: string }
/** What a push's evaluation runs, and what it skips and why: the dry run's answer. */
export interface PushPlan { matched: PlannedRequirement[]; skipped: SkippedRequirement[] }

export function planPush(requirements: readonly EffectiveRequirement[], ctx: PushContext): PushPlan {
  const plan: PushPlan = { matched: [], skipped: [] };
  for (const q of requirements) {
    const held = q.when ? conditionHolds(q.when, ctx) : { holds: true, why: 'it has no condition' };
    if (held.holds) plan.matched.push({ id: q.id, level: q.level, ...(q.dir !== undefined ? { dir: q.dir } : {}), why: held.why, checks: q.checks });
    else plan.skipped.push({ id: q.id, level: q.level, reason: held.why });
  }
  return plan;
}

/** One check as the job ran it: its exit code, and what it measured. */
export interface CheckRun { name: string; exit: number; measured?: Record<string, number> }
export interface RequirementRun { id: string; checks: CheckRun[] }

export interface JudgedCheck { name: string; run: string; exit: number; thresholds?: Record<string, Threshold>; measured?: Record<string, number>; ci?: CiCheck; passed: boolean; problem?: string }
export interface JudgedRequirement { id: string; level: RequirementLevel; status: 'passed' | 'failed' | 'skipped'; reason?: string; checks?: JudgedCheck[] }
export interface PushEvaluation { passed: boolean; requirements: JudgedRequirement[] }

/** Why a check run does not pass, or undefined. */
function checkProblem(c: RequirementCheck, ran: CheckRun): string | undefined {
  if (ran.exit !== 0) return `it exited ${ran.exit}`;
  for (const [name, t] of Object.entries(c.thresholds ?? {})) {
    const v = ran.measured?.[name];
    if (v === undefined) return `it printed no measure ${name} (a line ${MEASURE_PREFIX} ${name}=<number>)`;
    if (t.min !== undefined && v < t.min) return `${name} ${v} is under its minimum ${t.min}`;
    if (t.max !== undefined && v > t.max) return `${name} ${v} is over its maximum ${t.max}`;
  }
  return undefined;
}

/** The evaluation of a push: each matched requirement passes when each of its checks ran and passed; every one must pass. */
export function judgeEvaluation(plan: PushPlan, runs: readonly RequirementRun[]): PushEvaluation {
  const requirements: JudgedRequirement[] = plan.matched.map((q) => {
    const ran = runs.find((r) => r.id === q.id);
    if (!ran) return { id: q.id, level: q.level, status: 'failed', reason: 'its checks did not run' };
    const checks = q.checks.map((c): JudgedCheck => {
      const one = ran.checks.find((r) => r.name === c.name);
      const base = { name: c.name, run: c.run, exit: one?.exit ?? -1, ...(c.thresholds ? { thresholds: c.thresholds } : {}), ...(one?.measured ? { measured: one.measured } : {}), ...(c.ci ? { ci: c.ci } : {}) };
      const problem = one ? checkProblem(c, one) : 'it did not run';
      return problem === undefined ? { ...base, passed: true } : { ...base, passed: false, problem };
    });
    return { id: q.id, level: q.level, status: checks.every((c) => c.passed) ? 'passed' : 'failed', checks };
  });
  for (const s of plan.skipped) requirements.push({ id: s.id, level: s.level, status: 'skipped', reason: s.reason });
  return { passed: requirements.every((q) => q.status !== 'failed'), requirements };
}
