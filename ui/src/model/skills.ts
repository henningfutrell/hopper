// The Skills page (issue #1911, design.md "The Skills page"), pure: where each library skill came from, which skill each
// kind of work gets and which setting chose it, which settings name a skill, a draft's files and what is wrong with them,
// the skills a skill requires, and the line a job's timeline shows for its work skill. The name and path checks copy the daemon's
// (src/domain/skill-library.ts: skillNameProblem, skillFilesProblem) so the page says what is wrong before Save; the
// daemon checks again and has the last word.
import type { LibrarySkillSummary, LibrarySkillVersion, SkillLibraryView, WorkKind, WorkSkillChoice, WorkSkillChosen, WorkSkillFrom } from '../../../src/domain/skill-library.ts';
import type { ConditionalSkillChosen, DoneCriterion, SkillRule } from '../../../src/domain/conditional-skills.ts';

export const SKILL_FILE = 'SKILL.md';
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** Each kind of work as a person reads it. */
export const KIND_LABEL: Readonly<Record<WorkKind, string>> = { code: 'Code work', research: 'Research', proposal: 'Proposals' };

/** The short form of a version id, as the page shows it. */
export const shortVersion = (version: string): string => version.slice(0, 8);

/** Where a version came from: built-in, written by a person, a copy of another skill's version, or a repository's folder. */
export function sourceLine(v: Pick<LibrarySkillVersion, 'source' | 'by'>): string {
  if (v.source.kind === 'built-in') return 'built-in';
  if (v.source.kind === 'created') return `written by ${v.by}`;
  if (v.source.kind === 'imported') return `imported from ${v.source.repo}${v.source.path ? `/${v.source.path}` : ''} at ${v.source.ref} ${shortVersion(v.source.commit)}, by ${v.by}`;
  return `a copy of ${v.source.name} ${shortVersion(v.source.version)}, by ${v.by}`;
}

/** One kind of work: the skill the user's setting names (none: the default), the skill a job gets, and which setting chose it. */
export interface KindRow { kind: WorkKind; label: string; setting: string | undefined; gets: string; from: Exclude<WorkSkillFrom, 'repo'> }

export function kindRows(view: SkillLibraryView): KindRow[] {
  return view.kinds.map((kind) => {
    const setting = view.workSkills.kinds[kind];
    return { kind, label: KIND_LABEL[kind], setting, gets: setting ?? view.defaults[kind], from: setting ? 'user' : 'default' };
  });
}

/** Each repository with a choice of its own, sorted by name. */
export const repoRows = (view: SkillLibraryView): { repo: string; choice: WorkSkillChoice }[] =>
  Object.entries(view.workSkills.repos).sort(([a], [b]) => a.localeCompare(b)).map(([repo, choice]) => ({ repo, choice }));

/** The skill `name` names: the built-in skill an alias names (issue #2145), else itself. */
export const skillNamed = (view: Pick<SkillLibraryView, 'aliases'>, name: string): string => (Object.hasOwn(view.aliases ?? {}, name) ? view.aliases[name]! : name);

/** The other names of skill `name`, as aliases of it (issue #2145). */
export const aliasesOf = (view: Pick<SkillLibraryView, 'aliases'>, name: string): string[] => Object.entries(view.aliases ?? {}).filter(([, to]) => to === name).map(([alias]) => alias);

/** Each setting that names `name`: `every repository: <kind>`, then `<repo>: <kind>`. The daemon refuses to remove such a skill. */
export function settingsNaming(view: SkillLibraryView, name: string): string[] {
  const names = (n: string | undefined) => n !== undefined && skillNamed(view, n) === name;
  const of = (where: string, choice: WorkSkillChoice) => view.kinds.filter((k) => names(choice[k])).map((k) => `${where}: ${KIND_LABEL[k]}`);
  const rules = (view.workSkills.rules ?? []).filter((r) => names(r.skill)).map((r) => `a skill rule: ${ruleLine(r)}`);
  return [...of('every repository', view.workSkills.kinds), ...repoRows(view).flatMap((r) => of(r.repo, r.choice)), ...rules];
}

/** A skill rule's conditions as one line (issue #1924): each condition, one of its values each. */
export const ruleLine = (r: SkillRule): string => [
  ...(r.repos?.length ? [`repository ${r.repos.join(' or ')}`] : []),
  ...(r.labels?.length ? [`label ${r.labels.join(' or ')}`] : []),
  ...(r.kinds?.length ? [`kind of work ${r.kinds.map((k) => KIND_LABEL[k]).join(' or ')}`] : []),
  ...(r.paths?.length ? [`the change touches ${r.paths.join(' or ')}`] : []),
].join(' and ');

/** Each skill rule in its order, with its line; `index` is its place in the list the save sends. */
export const ruleRows = (view: SkillLibraryView): { index: number; skill: string; line: string }[] =>
  (view.workSkills.rules ?? []).map((r, index) => ({ index, skill: r.skill, line: ruleLine(r) }));

/** A skill rule as its editor holds it (issue #1924 part 5): each list of words as one text, the kinds as boxes. */
export interface RuleDraft { skill: string; repos: string; labels: string; kinds: WorkKind[]; paths: string }

/** A new rule's draft: the first library skill, no condition yet. */
export const emptyRuleDraft = (view: SkillLibraryView): RuleDraft => ({ skill: view.skills[0]?.name ?? '', repos: '', labels: '', kinds: [], paths: '' });

export const ruleDraftOf = (r: SkillRule): RuleDraft => ({
  skill: r.skill, repos: (r.repos ?? []).join(', '), labels: (r.labels ?? []).join(', '), kinds: [...(r.kinds ?? [])], paths: (r.paths ?? []).join(', '),
});

const words = (text: string): string[] => text.split(/[\s,]+/).filter((w) => w !== '');

/** The draft as the rule a save sends, as the daemon keeps it (keptRule): repositories lowercased, empty conditions dropped. */
export function ruleOfDraft(d: RuleDraft): SkillRule {
  const repos = words(d.repos).map((r) => r.toLowerCase());
  const labels = words(d.labels);
  const paths = words(d.paths);
  return {
    skill: d.skill,
    ...(repos.length ? { repos } : {}), ...(labels.length ? { labels } : {}), ...(d.kinds.length ? { kinds: [...d.kinds] } : {}), ...(paths.length ? { paths } : {}),
  };
}

// The daemon's checks (src/domain/conditional-skills.ts skillRuleProblem), copied: the UI imports types only.
const RULE_REPO = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

/** What stops a save of this rule, in words, or undefined. */
export function ruleDraftProblem(view: SkillLibraryView, d: RuleDraft): string | undefined {
  if (!view.skills.some((s) => s.name === d.skill)) return `${d.skill || 'The skill'} is not in the library.`;
  const r = ruleOfDraft(d);
  if (!r.repos && !r.labels && !r.kinds && !r.paths) return 'Name at least one condition: a repository, a label, a kind of work or a path.';
  const repo = r.repos?.find((x) => !RULE_REPO.test(x));
  if (repo !== undefined) return `${repo} is no repository: write owner/name, or a GitLab project's group/name.`;
  const path = r.paths?.find((p) => p.startsWith('/') || p.split('/').includes('..'));
  if (path !== undefined) return `${path} is no relative path glob.`;
  return undefined;
}

/** The first files of a new skill: a SKILL.md with its name and a description to fill in. */
export const newSkillFiles = (name: string): Record<string, string> => ({
  [SKILL_FILE]: `---\nname: ${name}\ndescription: What this skill is for, in one line.\n---\n# ${name}\n\nWhat the job does, step by step.\n`,
});

/** One file of a draft, as the editor holds it. */
export interface DraftFile { path: string; text: string }

/** A version's files as editor rows, SKILL.md first, then by path. */
export const draftRows = (files: Record<string, string>): DraftFile[] =>
  Object.entries(files).sort(([a], [b]) => (a === SKILL_FILE ? -1 : b === SKILL_FILE ? 1 : a.localeCompare(b))).map(([path, text]) => ({ path, text }));

/** The rows as the files a save sends, each path trimmed. */
export const draftFiles = (rows: readonly DraftFile[]): Record<string, string> => Object.fromEntries(rows.map((r) => [r.path.trim(), r.text]));

/** What stops a save of this draft, in words, or undefined. */
export function draftProblem(name: string, rows: readonly DraftFile[]): string | undefined {
  if (!NAME.test(name)) return 'Write the name in lowercase letters, digits and dashes, at most 63.';
  const paths = rows.map((r) => r.path.trim());
  if (paths.some((p) => p === '')) return 'every file needs a path.';
  const twice = paths.find((p, i) => paths.indexOf(p) !== i);
  if (twice) return `${twice} is there twice.`;
  const bad = paths.find((p) => p.length > 160 || p.split('/').length > 4 || !p.split('/').every((s) => SEGMENT.test(s)));
  if (bad) return `${bad} is no file path in a skill: relative, at most 4 parts of letters, digits, _ . - and 160 characters.`;
  if (!paths.includes(SKILL_FILE)) return `A skill needs a ${SKILL_FILE}.`;
  return undefined;
}

const FROM: Readonly<Record<WorkSkillFrom, string>> = { repo: "the repository's setting", user: 'your setting', default: 'the default' };

/** A job's `job.work_skill_chosen` as one line: the kind, the skill, its version, which setting chose it, the skills it got beside it and the ones it did not. */
export function workSkillChosenLine(c: WorkSkillChosen): string {
  const requires = c.requires?.length ? `; with ${c.requires.map((r) => `${r.name} ${shortVersion(r.version)}`).join(', ')}` : '';
  const missing = c.missing?.length ? `; not in the library: ${c.missing.join(', ')}` : '';
  return `${c.kind}: ${c.name} ${shortVersion(c.version)} (${c.seq === 0 ? 'built-in' : `version ${c.seq}`}), by ${FROM[c.from]}${requires}${missing}`;
}

/** `skill.loaded` (issue #582) as its timeline line: for a built-in library skill (issue #1909) its version, the file, or the repository's own copy the job follows. */
export function skillLoadedLine(d: { skill: string; asset?: string; version?: string; repoCopy?: { path: string; tree: string; commit: string; changed: boolean } }): string {
  if (d.repoCopy) {
    const c = d.repoCopy;
    return `follows the repository's own ${d.skill} at ${c.path} (tree ${shortVersion(c.tree)}, commit ${shortVersion(c.commit)}${c.changed ? ', with changes' : ''})${d.version ? `, not the hopper's ${shortVersion(d.version)}` : ''}`;
  }
  if (d.version) return `loaded ${d.skill} ${shortVersion(d.version)}${d.asset ? `, file ${d.asset}` : ''}`;
  return `loaded ${d.skill}${d.asset ? ` for ${d.asset}` : ''}`;
}

/** The skills a library skill requires, the ones the library does not have said so; undefined when it requires none. */
export function requiresLine(view: SkillLibraryView, skill: Pick<LibrarySkillSummary, 'requires'>): string | undefined {
  if (!skill.requires?.length) return undefined;
  const there = new Set(view.skills.map((s) => s.name));
  return `requires ${skill.requires.map((n) => (there.has(skillNamed(view, n)) ? n : `${n} (not in the library)`)).join(', ')}`;
}

// The daemon's words for the done criteria (src/domain/conditional-skills.ts criteriaLine), copied: the UI imports types only.
const criteriaLine = (criteria: readonly DoneCriterion[]): string => criteria.map((c) => (c.kind === 'person-merges'
  ? `a person merges ${c.paths?.length ? `a change to ${c.paths.join(', ')}` : 'it'}, not the hopper`
  : c.kind === 'checks-passed'
  ? `every check named ${c.checks} passed`
  : `no terraform plan ${c.checks === undefined ? '' : `of the checks named ${c.checks} `}destroys or replaces ${(c.max ?? 0) === 0 ? 'a resource' : `more than ${c.max} ${c.max === 1 ? 'resource' : 'resources'}`}`)).join('; ');

/** A job's `job.conditional_skills_chosen` as one line (issue #1924): each skill, its version, why, and what the hopper checks. */
export const conditionalSkillsChosenLine = (d: { skills: ConditionalSkillChosen[] }): string =>
  `conditional skills: ${d.skills.map((c) => `${c.name} ${shortVersion(c.version)} (${c.seq === 0 ? 'built-in' : `version ${c.seq}`}), by ${c.why.join(', ')}${c.done.length > 0 ? `; done when ${criteriaLine(c.done)}` : ''}`).join('; ')}`;
