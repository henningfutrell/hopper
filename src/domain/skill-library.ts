// The skill library (issue #1911, design.md "The skill library"): the hopper keeps skills — a SKILL.md and the files beside
// it — as versioned records in the user's database, and gives each job the work skill of its kind of work. Built-in library
// skills ship with the hopper; a user creates one, edits it (a new version), or duplicates a built-in one to change it.
// Which skill each kind of work gets is the user's setting, per repository over the user's own, over the built-in default.
// A job's work skill is chosen once, at its first start, and kept: an edit or a new setting reaches the next job, never a
// running one. Not a skill of the broker (src/skills/, what the hopper sets up for a box), and not a run skill. Pure.

/** What a job was asked to do, for its work skill: the work itself (`code`), research, or a proposal; as its job cost kind. */
export const WORK_KINDS = ['code', 'research', 'proposal'] as const;
export type WorkKind = typeof WORK_KINDS[number];

/** A job's kind of work: research, a proposal, else the work itself. */
export const workKindOf = (spec: { research?: true; proposal?: true }): WorkKind => (spec.research ? 'research' : spec.proposal ? 'proposal' : 'code');

/** The built-in library skills, by name, and the one each kind of work gets while no setting names another. */
export const BUILT_IN_SKILL_NAMES = ['work', 'research', 'proposal'] as const;
export const DEFAULT_WORK_SKILLS: Readonly<Record<WorkKind, string>> = { code: 'work', research: 'research', proposal: 'proposal' };

/** The file every library skill has: what the job reads first. */
export const SKILL_FILE = 'SKILL.md';
/** Limits of one version: its files, each file (as a credential file on the job's machine), and their size together. */
export const SKILL_MAX_FILES = 32;
export const SKILL_MAX_FILE = 64 * 1024;
export const SKILL_MAX_BYTES = 256 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** Where a version came from: shipped with the hopper, written by a person, or a copy of another skill's version. */
export type LibrarySkillSource =
  | { kind: 'built-in' }
  | { kind: 'created' }
  | { kind: 'duplicated'; name: string; version: string };

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
}

/** Each kind of work's skill by name; absent: the next setting down. */
export type WorkSkillChoice = Partial<Record<WorkKind, string>>;

/** The user's choice of work skills: for every repository, and per repository (`owner/name` lowercased), which wins. */
export interface WorkSkillSettings {
  kinds: WorkSkillChoice;
  repos: Record<string, WorkSkillChoice>;
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

/** The settings after a change; a repository with no choice left is dropped. */
export function patchWorkSkills(s: WorkSkillSettings, p: WorkSkillPatch): WorkSkillSettings {
  const repos = { ...s.repos };
  for (const [repo, choice] of Object.entries(p.repos ?? {})) {
    const key = repo.toLowerCase();
    const next = patched(repos[key] ?? {}, choice);
    if (Object.keys(next).length === 0) delete repos[key];
    else repos[key] = next;
  }
  return { kinds: patched(s.kinds, p.kinds ?? {}), repos };
}

/** Every skill name a setting names. */
export const namedSkills = (s: WorkSkillSettings): string[] =>
  [...new Set([...Object.values(s.kinds), ...Object.values(s.repos).flatMap((c) => Object.values(c))].filter((n): n is string => typeof n === 'string'))];

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
  return bytes > SKILL_MAX_BYTES ? `a skill holds at most ${SKILL_MAX_BYTES / 1024} KiB; this is ${bytes} bytes` : undefined;
}

/** A SKILL.md's description: its front matter's `description:`, else its first heading or line. */
export function skillDescription(text: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  const described = front?.split('\n').find((l) => l.startsWith('description:'))?.slice('description:'.length).trim();
  if (described) return described.replace(/^["']|["']$/g, '').slice(0, 300);
  const body = front === undefined ? text : text.slice(front.length + 8);
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l !== '') ?? '').slice(0, 300);
}

/** The work skill a job got (issue #1911): kept on its timeline as `job.work_skill_chosen`, and what each later start delivers. */
export interface WorkSkillChosen { kind: WorkKind; name: string; version: string; seq: number; from: WorkSkillFrom }

/** The variable that names the work skill's SKILL.md on the job's machine. */
export const WORK_SKILL_VARIABLE = 'HOPPER_WORK_SKILL';
/** Where the work skill's files go under the job's credentials dir. */
export const workSkillDir = (name: string): string => `work-skill/${name}`;

/** The line the job's prompt carries for its work skill, after the job rules. */
export const workSkillRule = (c: WorkSkillChosen): string =>
  `[hopper work skill] This job's skill for its kind of work (${c.kind}) is ${c.name}, version ${c.version}. When the variable ${WORK_SKILL_VARIABLE} is set, read the file it names before you start, and follow it where the job rules and the repository's rules do not say otherwise. Its other files are in the same directory.`;

/** The job rules followed by the work skill's line. */
export const withWorkSkill = (jobRules: string, c: WorkSkillChosen): string => (jobRules === '' ? workSkillRule(c) : `${jobRules}\n${workSkillRule(c)}`);

/** The work skill's files as the job's credentials files, and the variable that names its SKILL.md. */
export const workSkillCredentials = (c: WorkSkillChosen, files: Record<string, string>): { files: Record<string, string>; paths: Record<string, string> } => ({
  files: Object.fromEntries(Object.entries(files).map(([path, text]) => [`${workSkillDir(c.name)}/${path}`, text])),
  paths: { [WORK_SKILL_VARIABLE]: `${workSkillDir(c.name)}/${SKILL_FILE}` },
});
