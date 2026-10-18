// The skill library (issue #1911, design.md "The skill library"): the hopper keeps skills — a SKILL.md and the files beside
// it — as versioned records in the user's database, and gives each job the work skill of its kind of work. Built-in library
// skills ship with the hopper; a user creates one, edits it (a new version), or duplicates a built-in one to change it.
// Which skill each kind of work gets is the user's setting, per repository over the user's own, over the built-in default.
// A job's work skill is chosen once, at its first start, and kept: an edit or a new setting reaches the next job, never a
// running one. A skill may require others (its SKILL.md's `requires:`): they go to the job beside it, each version kept for
// the job too. Not a skill of the broker (src/skills/, what the hopper sets up for a box), and not a run skill. Pure.
import { DONE_FILE, doneFileProblem, keptRule, type SkillRule } from './conditional-skills.ts';

/** What a job was asked to do, for its work skill: the work itself (`code`), research, or a proposal; as its job cost kind. */
export const WORK_KINDS = ['code', 'research', 'proposal'] as const;
export type WorkKind = typeof WORK_KINDS[number];

/** A job's kind of work: research, a proposal, else the work itself. */
export const workKindOf = (spec: { research?: true; proposal?: true }): WorkKind => (spec.research ? 'research' : spec.proposal ? 'proposal' : 'code');

/** The built-in library skills, by name, and the one each kind of work gets while no setting names another. */
export const BUILT_IN_SKILL_NAMES = ['work', 'research', 'proposal', 'orchestrate', 'iac'] as const;
export const DEFAULT_WORK_SKILLS: Readonly<Record<WorkKind, string>> = { code: 'work', research: 'research', proposal: 'proposal' };

/** The file every library skill has: what the job reads first. */
export const SKILL_FILE = 'SKILL.md';
/** Limits of one version: its files, each file (as a credential file on the job's machine), and their size together. */
export const SKILL_MAX_FILES = 32;
export const SKILL_MAX_FILE = 64 * 1024;
export const SKILL_MAX_BYTES = 256 * 1024;
/** The skills a job gets beside its work skill, at most: those it requires, and theirs. */
export const SKILL_MAX_REQUIRED = 8;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/**
 * Where a version came from: shipped with the hopper, written by a person, a copy of another skill's version, or imported
 * from a folder (`path`, '' the root) of a GitHub repository at a `ref` it follows, read at `commit`.
 */
export type LibrarySkillSource =
  | { kind: 'built-in' }
  | { kind: 'created' }
  | { kind: 'duplicated'; name: string; version: string }
  | ImportedSkillSource;
export interface ImportedSkillSource { kind: 'imported'; repo: string; path: string; ref: string; commit: string }

/** The ref an import follows when none is named: the repository's default branch, read again at each refresh. */
export const IMPORT_DEFAULT_REF = 'HEAD';

/** The folder of a repository that holds a skill, its slashes at the ends dropped ('' or '.': the root); or why it is none. */
export function importPathOf(raw: string): { path: string } | { problem: string } {
  const path = raw.trim().replace(/^\/+|\/+$/g, '');
  if (path === '' || path === '.') return { path: '' };
  const segments = path.split('/');
  if (path.length > 200 || segments.length > 8 || !segments.every((x) => SEGMENT.test(x) && x !== '..' && x !== '.')) {
    return { problem: `${JSON.stringify(raw)} is no folder of a repository: at most 8 parts of letters, digits, _ . - and 200 characters` };
  }
  return { path };
}

/** One entry of GitHub's tree of the skill's folder (`?recursive=1`): its path in the folder. */
export interface SkillTreeEntry { path: string; type: string; sha: string; size?: number }

/** The files of the skill's folder to read, each by its blob; or why the folder is no skill — before any file is read. */
export function skillTreeFiles(entries: readonly SkillTreeEntry[]): { files: { path: string; sha: string }[] } | { problem: string } {
  const blobs = entries.filter((e) => e.type === 'blob');
  if (!blobs.some((e) => e.path === SKILL_FILE)) return { problem: `the folder has no ${SKILL_FILE}` };
  if (blobs.length > SKILL_MAX_FILES) return { problem: `a skill holds at most ${SKILL_MAX_FILES} files; the folder has ${blobs.length}` };
  const big = blobs.find((e) => (e.size ?? 0) > SKILL_MAX_FILE);
  if (big) return { problem: `${big.path}: a file of a skill holds at most ${SKILL_MAX_FILE / 1024} KiB` };
  return { files: blobs.map((e) => ({ path: e.path, sha: e.sha })) };
}

/** The name an imported skill takes when none is given: the folder's last part, else the repository's name, as a skill name. */
export function importedName(repo: string, path: string): string {
  const named = (x: string) => x.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
  return named(path.split('/').at(-1) ?? '') || named(repo.split('/').at(-1) ?? '');
}

/** One version of a library skill: its files and their content id (16 hex, as a run skill's), never changed once kept. */
export interface LibrarySkillVersion {
  name: string;
  /** The content id of its files: the same files, the same id. */
  version: string;
  /** Its place among the skill's versions: 1, 2, … A built-in one has 0. */
  seq: number;
  /** Path → content. Text only. */
  files: Record<string, string>;
  source: LibrarySkillSource;
  /** Who kept it, and when; a built-in one: `the hopper`, and no time. */
  by: string;
  at?: string;
}

/** A library skill as the list shows it: its newest version, without the files, and how many it has. */
export interface LibrarySkillSummary {
  name: string;
  builtIn: boolean;
  /** The first line of its SKILL.md's `description:`, else its first heading or line. */
  description: string;
  latest: Omit<LibrarySkillVersion, 'files'>;
  versions: number;
  /** The skills its newest version requires, by name. */
  requires: string[];
}

/** As GET /api/skill-library answers it: every skill, the built-in ones first, and the choice of work skills. */
export interface SkillLibraryView {
  skills: LibrarySkillSummary[];
  workSkills: WorkSkillSettings;
  defaults: Readonly<Record<WorkKind, string>>;
  kinds: readonly WorkKind[];
}

/** Each kind of work's skill by name; absent: the next setting down. */
export type WorkSkillChoice = Partial<Record<WorkKind, string>>;

/**
 * The user's choice of work skills: for every repository, and per repository (`owner/name` lowercased), which wins; and the
 * skill rules (issue #1924) that give a job conditional skills beside its work skill. Absent: none.
 */
export interface WorkSkillSettings {
  kinds: WorkSkillChoice;
  repos: Record<string, WorkSkillChoice>;
  rules?: SkillRule[];
}

export const DEFAULT_WORK_SKILL_SETTINGS: WorkSkillSettings = { kinds: {}, repos: {} };

/** The skill library's records (src/store/skill-library.ts). */
export interface SkillLibraryRepository {
  /** Each skill's newest version, of the skills not removed, by name. */
  latest(): LibrarySkillVersion[];
  /** A skill's versions, newest first; a removed skill has none. */
  versions(name: string): LibrarySkillVersion[];
  /** One version by its id, a removed skill's too: a job that got it before still gets it. */
  version(name: string, version: string): LibrarySkillVersion | undefined;
  /** Keeps a new version; its seq is the next. A skill made again after its removal starts after the old versions, which stay for their jobs. */
  add(v: Omit<LibrarySkillVersion, 'seq' | 'at'> & { at: string }): LibrarySkillVersion;
  /** Marks every version of a skill removed: no list shows it, and no new job gets it. */
  remove(name: string, at: string): boolean;
  getWorkSkills(): WorkSkillSettings | undefined;
  setWorkSkills(s: WorkSkillSettings): void;
}

/** Which setting chose a job's work skill. */
export type WorkSkillFrom = 'repo' | 'user' | 'default';

/** The work skill a job of `repo` and `kind` gets, by name, and which setting chose it: the repository's, the user's, else the default. */
export function workSkillFor(s: WorkSkillSettings, repo: string | undefined, kind: WorkKind): { name: string; from: WorkSkillFrom } {
  const own = repo ? s.repos[repo.toLowerCase()]?.[kind] : undefined;
  if (own) return { name: own, from: 'repo' };
  const user = s.kinds[kind];
  if (user) return { name: user, from: 'user' };
  return { name: DEFAULT_WORK_SKILLS[kind], from: 'default' };
}

/** A change of the settings: `kinds` sets each kind named, `null` to the default again; `repos` the same per repository. */
export interface WorkSkillPatch {
  kinds?: Partial<Record<WorkKind, string | null>>;
  repos?: Record<string, Partial<Record<WorkKind, string | null>>>;
  /** The skill rules, all of them (issue #1924); absent: as they are. */
  rules?: SkillRule[];
}

const patched = (choice: WorkSkillChoice, p: Partial<Record<WorkKind, string | null>>): WorkSkillChoice => {
  const next: WorkSkillChoice = { ...choice };
  for (const kind of WORK_KINDS) {
    const v = p[kind];
    if (v === null) delete next[kind];
    else if (v !== undefined) next[kind] = v;
  }
  return next;
};

/** The settings after a change; a repository with no choice left is dropped, and so are no rules. */
export function patchWorkSkills(s: WorkSkillSettings, p: WorkSkillPatch): WorkSkillSettings {
  const repos = { ...s.repos };
  for (const [repo, choice] of Object.entries(p.repos ?? {})) {
    const key = repo.toLowerCase();
    const next = patched(repos[key] ?? {}, choice);
    if (Object.keys(next).length === 0) delete repos[key];
    else repos[key] = next;
  }
  const rules = (p.rules ?? s.rules ?? []).map(keptRule);
  return { kinds: patched(s.kinds, p.kinds ?? {}), repos, ...(rules.length > 0 ? { rules } : {}) };
}

/** Every skill name a setting names. */
export const namedSkills = (s: WorkSkillSettings): string[] =>
  [...new Set([...Object.values(s.kinds), ...Object.values(s.repos).flatMap((c) => Object.values(c)), ...(s.rules ?? []).map((r) => r.skill)].filter((n): n is string => typeof n === 'string'))];

/** Why `name` cannot name a library skill, or undefined. */
export function skillNameProblem(name: string): string | undefined {
  return NAME.test(name) ? undefined : `${JSON.stringify(name)} is no skill name: write lowercase letters, digits and dashes, at most 63`;
}

/** Why `files` cannot be a library skill's version, or undefined: a SKILL.md, relative paths with no `..`, within the limits. */
export function skillFilesProblem(files: Record<string, string>): string | undefined {
  const paths = Object.keys(files);
  if (!paths.includes(SKILL_FILE)) return `a skill needs a ${SKILL_FILE}`;
  if (paths.length > SKILL_MAX_FILES) return `a skill holds at most ${SKILL_MAX_FILES} files; this has ${paths.length}`;
  let bytes = 0;
  for (const path of paths) {
    const segments = path.split('/');
    if (path.length > 160 || segments.length > 4 || !segments.every((s) => SEGMENT.test(s))) return `${JSON.stringify(path)} is no file path in a skill: relative, at most 4 parts of letters, digits, _ . - and 160 characters`;
    if (typeof files[path] !== 'string') return `${path} is no text`;
    if (files[path].length > SKILL_MAX_FILE) return `${path}: a file of a skill holds at most ${SKILL_MAX_FILE / 1024} KiB`;
    bytes += Buffer.byteLength(files[path], 'utf8');
  }
  if (bytes > SKILL_MAX_BYTES) return `a skill holds at most ${SKILL_MAX_BYTES / 1024} KiB; this is ${bytes} bytes`;
  const done = files[DONE_FILE] === undefined ? undefined : doneFileProblem(files[DONE_FILE]);
  if (done) return done;
  const requires = skillRequires(files[SKILL_FILE]!);
  const bad = requires.find((n) => skillNameProblem(n));
  if (bad !== undefined) return `${SKILL_FILE} requires ${JSON.stringify(bad)}: no skill name`;
  return requires.length > SKILL_MAX_REQUIRED ? `${SKILL_FILE} requires at most ${SKILL_MAX_REQUIRED} skills; this names ${requires.length}` : undefined;
}

const frontMatterOf = (text: string): string | undefined => /^---\n([\s\S]*?)\n---/.exec(text)?.[1];

/**
 * The skills a SKILL.md requires, by name, each once: its front matter's `requires:` — names on its line, apart by commas,
 * in brackets or not, or one `- name` a line below it. None without one.
 */
export function skillRequires(text: string): string[] {
  const lines = frontMatterOf(text)?.split('\n') ?? [];
  const at = lines.findIndex((l) => /^requires:/.test(l));
  if (at < 0) return [];
  const inline = lines[at]!.slice('requires:'.length).trim().replace(/^\[|\]$/g, '');
  const listed = inline !== '' ? inline.split(',') : [];
  for (const line of inline !== '' ? [] : lines.slice(at + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (!item) break;
    listed.push(item[1]!);
  }
  return [...new Set(listed.map((n) => n.trim().replace(/^["']|["']$/g, '')).filter((n) => n !== ''))];
}

/** A SKILL.md's description: its front matter's `description:`, else its first heading or line. */
export function skillDescription(text: string): string {
  const front = frontMatterOf(text);
  const described = front?.split('\n').find((l) => l.startsWith('description:'))?.slice('description:'.length).trim();
  if (described) return described.replace(/^["']|["']$/g, '').slice(0, 300);
  const body = front === undefined ? text : text.slice(front.length + 8);
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l !== '') ?? '').slice(0, 300);
}

/** A skill a job got beside its work skill, because the work skill (or one it requires) requires it: the version kept for the job. */
export interface RequiredSkill { name: string; version: string; seq: number }

/**
 * The work skill a job got (issue #1911): kept on its timeline as `job.work_skill_chosen`, and what each later start delivers.
 * `requires`: the skills it got beside it; `missing`: the ones required that it did not get (not in the library, or past
 * the limit). Both absent on a choice made before skills required others.
 */
export interface WorkSkillChosen { kind: WorkKind; name: string; version: string; seq: number; from: WorkSkillFrom; requires?: RequiredSkill[]; missing?: string[] }

/** The variable that names the work skill's SKILL.md on the job's machine. */
export const WORK_SKILL_VARIABLE = 'HOPPER_WORK_SKILL';
/** Where the work skill's files go under the job's credentials dir. */
export const workSkillDir = (name: string): string => `work-skill/${name}`;

/** The line the job's prompt carries for its work skill, after the job rules: the skills it requires too, and those it did not get. */
export function workSkillRule(c: WorkSkillChosen): string {
  const requires = (c.requires ?? []).map((r) => `${r.name} (version ${r.version}): read its ${SKILL_FILE} in ../${r.name}/ beside the work skill's directory when the work skill says to.`);
  const missing = (c.missing ?? []).map((n) => `The library has no skill ${n} that it requires: go on without it.`);
  return [
    `[hopper work skill] This job's skill for its kind of work (${c.kind}) is ${c.name}, version ${c.version}. When the variable ${WORK_SKILL_VARIABLE} is set, read the file it names before you start, and follow it where the job rules and the repository's rules do not say otherwise. Its other files are in the same directory.`,
    ...requires.map((r) => `It requires ${r}`), ...missing,
  ].join(' ');
}

/** The job rules followed by the work skill's line. */
export const withWorkSkill = (jobRules: string, c: WorkSkillChosen): string => (jobRules === '' ? workSkillRule(c) : `${jobRules}\n${workSkillRule(c)}`);

/** The files of the work skill (first) and of the skills it requires as the job's credentials files, each skill in a directory of its own, and the variable that names the work skill's SKILL.md. */
export const workSkillCredentials = (skills: readonly { name: string; files: Record<string, string> }[]): { files: Record<string, string>; paths: Record<string, string> } => ({
  files: Object.fromEntries(skills.flatMap((s) => Object.entries(s.files).map(([path, text]) => [`${workSkillDir(s.name)}/${path}`, text]))),
  paths: { [WORK_SKILL_VARIABLE]: `${workSkillDir(skills[0]!.name)}/${SKILL_FILE}` },
});
