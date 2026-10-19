// Library skills `hopper-skill` serves (issue #1909, design.md "Library skills through hopper-skill"): built-in skills of
// the skill library (src/skill-library/built-in/) that a job may also load by name, so every job of every agent CLI gets
// the same text, at the same version, as the work skill's files carry (issue #1911). One text: the library's. A load
// answers its `SKILL.md`, headed by its version; another file of it is its asset (`sh "$HOPPER_SKILL" work FILE`). An alias
// (`orchestrate`, issue #2145) loads the skill it names.
// A job that follows its repository's own copy says so (`--repo-copy`): the copy's folder, git tree and commit go on
// `skill.loaded`, so the job record says which one it used.
import { skillNameOf, type LibrarySkillVersion } from '../domain/skill-library.ts';
import { builtInOf } from '../skill-library/index.ts';
import { SERVED_LINES } from './catalog.ts';

export type ServedSkillName = keyof typeof SERVED_LINES;
export const SERVED_SKILL_NAMES = Object.keys(SERVED_LINES) as ServedSkillName[];

/** The file a load of a served skill answers. */
export const SERVED_ENTRY = 'SKILL.md';

/** Whether a load of `name` answers a served skill: by its name, or an alias of it. */
export const isServedSkill = (name: string): boolean => (SERVED_SKILL_NAMES as readonly string[]).includes(skillNameOf(name));

/** The built-in library skill of that name or alias, as this build has it. */
export const servedSkill = (name: string): LibrarySkillVersion => builtInOf(name)!;

/** What a load answers: the entry, or the file `file` names, headed by its version; or what is wrong. */
export function servedText(skill: LibrarySkillVersion, file?: string): { text: string } | { no: string } {
  const name = file ?? SERVED_ENTRY;
  const text = skill.files[name];
  if (text === undefined) return { no: `the skill ${skill.name} has no file ${name}. It has: ${Object.keys(skill.files).join(', ')}.` };
  return { text: `skill ${skill.name}, version ${skill.version}${file ? `, file ${file}` : ''}\n\n${text}` };
}

/** A repository's own copy of a skill a job follows: its folder in the repository, its git tree and commit, and whether it has changes. */
export interface RepoCopy { path: string; tree: string; commit: string; changed: boolean }

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATH_PART = /^[\w.-]+$/;
const PATH_MAX = 160;

/** The repository copy a load names (`repoCopy`, `tree`, `commit`, `changed`, as hopper-skill sends them); undefined: none; or what is wrong. */
export function repoCopyOf(f: { repoCopy?: string; tree?: string; commit?: string; changed?: string }): RepoCopy | { no: string } | undefined {
  const at = f.repoCopy;
  if (at === undefined) return undefined;
  const path = at.replace(/\/+$/, '') || '.';
  const parts = path.split('/');
  const pathOk = path === '.' || (path.length <= PATH_MAX && parts.every((p) => PATH_PART.test(p) && p !== '..' && p !== '.'));
  if (!pathOk) return { no: `the repository copy's folder must be a path in the repository: letters, digits, ".", "_", "-" and "/", at most ${PATH_MAX} characters, no "..".` };
  const tree = f.tree ?? ''; const commit = f.commit ?? '';
  if (!OBJECT_ID.test(tree) || !OBJECT_ID.test(commit)) return { no: 'the repository copy needs its git tree and commit, as hopper-skill reads them with git.' };
  return { path, tree, commit, changed: f.changed === '1' };
}
