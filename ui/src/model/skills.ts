// The Skills page (issue #1911, design.md "The Skills page"), pure: where each library skill came from, which skill each
// kind of work gets and which setting chose it, which settings name a skill, a draft's files and what is wrong with them,
// and the line a job's timeline shows for its work skill. The name and path checks copy the daemon's
// (src/domain/skill-library.ts: skillNameProblem, skillFilesProblem) so the page says what is wrong before Save; the
// daemon checks again and has the last word.
import type { LibrarySkillVersion, SkillLibraryView, WorkKind, WorkSkillChoice, WorkSkillChosen, WorkSkillFrom } from '../../../src/domain/skill-library.ts';

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

/** Each setting that names `name`: `every repository: <kind>`, then `<repo>: <kind>`. The daemon refuses to remove such a skill. */
export function settingsNaming(view: SkillLibraryView, name: string): string[] {
  const of = (where: string, choice: WorkSkillChoice) => view.kinds.filter((k) => choice[k] === name).map((k) => `${where}: ${KIND_LABEL[k]}`);
  return [...of('every repository', view.workSkills.kinds), ...repoRows(view).flatMap((r) => of(r.repo, r.choice))];
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

/** A job's `job.work_skill_chosen` as one line: the kind, the skill, its version, and which setting chose it. */
export const workSkillChosenLine = (c: WorkSkillChosen): string =>
  `${c.kind}: ${c.name} ${shortVersion(c.version)} (${c.seq === 0 ? 'built-in' : `version ${c.seq}`}), by ${FROM[c.from]}`;
