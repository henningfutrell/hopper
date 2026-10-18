// The skill library (issue #1911, design.md "The skill library"): the built-in library skills — the files of each directory
// under `built-in/`, named by a content id as a run skill is —, the user's own, kept as versions in their database, and
// the choice of each kind of work's skill. Every change is an event. A job's work skill is chosen at its first start
// (`job.work_skill_chosen`) and the same version goes to each later start, on any machine: its files go into the job's
// credentials dir with the hopper's scripts (src/users/github-proxy.ts), and its line into the job rules. The skills it
// requires, and theirs, go beside it, each version chosen at the same first start and kept with it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseOf } from '../client/release.ts';
import {
  BUILT_IN_SKILL_NAMES, DEFAULT_WORK_SKILLS, DEFAULT_WORK_SKILL_SETTINGS, namedSkills, patchWorkSkills, skillDescription, skillFilesProblem,
  skillNameProblem, skillRequires, SKILL_FILE, SKILL_MAX_REQUIRED, WORK_KINDS, workKindOf, workSkillFor,
  type LibrarySkillSummary, type LibrarySkillVersion, type RequiredSkill, type SkillLibraryView, type WorkSkillChosen, type WorkSkillPatch,
  type WorkSkillSettings,
} from '../domain/skill-library.ts';
import type { UserStore } from '../domain/store.ts';
import type { Job } from '../domain/types.ts';

export type { SkillLibraryView };

const BY_HOPPER = 'the hopper';

function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path).split('\\').join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

let builtIns: LibrarySkillVersion[] | undefined;

/** The built-in library skills, as their files are in this build. */
export function builtInSkills(): LibrarySkillVersion[] {
  // Resolved here, not at import: a browser-like test environment imports this module with a URL that is no file URL.
  builtIns ??= BUILT_IN_SKILL_NAMES.map((name) => {
    const files = filesUnder(join(fileURLToPath(new URL('./built-in/', import.meta.url)), name));
    return { name, version: releaseOf(files).id, seq: 0, files, source: { kind: 'built-in' as const }, by: BY_HOPPER };
  });
  return builtIns;
}

const builtInOf = (name: string): LibrarySkillVersion | undefined => builtInSkills().find((s) => s.name === name);
const isBuiltIn = (name: string): boolean => (BUILT_IN_SKILL_NAMES as readonly string[]).includes(name);
const withoutFiles = ({ files: _files, ...v }: LibrarySkillVersion): Omit<LibrarySkillVersion, 'files'> => v;

/** A skill's newest version: a built-in one's, else the user's; undefined when there is none, or it was removed. */
export function latestSkill(store: UserStore, name: string): LibrarySkillVersion | undefined {
  return builtInOf(name) ?? store.skillLibrary.versions(name)[0];
}

export const workSkillSettings = (store: UserStore): WorkSkillSettings => store.skillLibrary.getWorkSkills() ?? DEFAULT_WORK_SKILL_SETTINGS;

export function skillLibraryView(store: UserStore): SkillLibraryView {
  const summary = (v: LibrarySkillVersion, versions: number): LibrarySkillSummary =>
    ({ name: v.name, builtIn: v.source.kind === 'built-in', description: skillDescription(v.files[SKILL_FILE] ?? ''), latest: withoutFiles(v), versions, requires: skillRequires(v.files[SKILL_FILE] ?? '') });
  const own = store.skillLibrary.latest().map((v) => summary(v, store.skillLibrary.versions(v.name).length));
  return { skills: [...builtInSkills().map((v) => summary(v, 1)), ...own], workSkills: workSkillSettings(store), defaults: DEFAULT_WORK_SKILLS, kinds: WORK_KINDS };
}

/** One version of a skill with its files (the newest unless `version` names one), and its versions without files. */
export function skillView(store: UserStore, name: string, version?: string): { skill: LibrarySkillVersion; versions: Omit<LibrarySkillVersion, 'files'>[] } | undefined {
  const b = builtInOf(name);
  if (b) return version === undefined || version === b.version ? { skill: b, versions: [withoutFiles(b)] } : undefined;
  const versions = store.skillLibrary.versions(name);
  const skill = version === undefined ? versions[0] : store.skillLibrary.version(name, version);
  return skill ? { skill, versions: versions.map(withoutFiles) } : undefined;
}

/** What a change answers: done, or refused with why and its HTTP kind. */
export type LibraryChange<T> = { ok: true; value: T } | { ok: false; code: 'invalid' | 'missing' | 'conflict'; error: string };
const refused = (code: 'invalid' | 'missing' | 'conflict', error: string): LibraryChange<never> => ({ ok: false, code, error });

/**
 * Keeps `files` as the newest version of `name`: a new skill (`create`, refused when one of the name exists), or an edit of
 * the user's own (`edit`, refused when there is none). A built-in one is never edited: duplicate it. The same files as its
 * newest version keep no new version. Recorded as `library_skill.saved`.
 */
export function saveSkill(store: UserStore, o: { mode: 'create' | 'edit'; name: string; files: Record<string, string>; by: string; now: string }): LibraryChange<LibrarySkillVersion> {
  const problem = skillNameProblem(o.name) ?? skillFilesProblem(o.files);
  if (problem) return refused('invalid', problem);
  if (isBuiltIn(o.name)) return refused('conflict', `${o.name} is a built-in skill: duplicate it to change it`);
  const version = releaseOf(o.files).id;
  return store.tx(() => {
    const last = store.skillLibrary.versions(o.name)[0];
    if (o.mode === 'create' && last) return refused('conflict', `a skill ${o.name} exists already: edit it`);
    if (o.mode === 'edit' && !last) return refused('missing', `no skill ${o.name}`);
    if (last?.version === version) return { ok: true as const, value: last };
    const kept = store.skillLibrary.add({ name: o.name, version, files: o.files, source: { kind: 'created' }, by: o.by, at: o.now });
    store.events.append({ type: 'library_skill.saved', data: { name: kept.name, version: kept.version, seq: kept.seq, source: kept.source, by: o.by } });
    return { ok: true as const, value: kept };
  });
}

/** Copies a version of `from` (its newest unless `version` names one), built-in or not, as a new skill `name`. */
export function duplicateSkill(store: UserStore, o: { from: string; version?: string; name: string; by: string; now: string }): LibraryChange<LibrarySkillVersion> {
  const problem = skillNameProblem(o.name);
  if (problem) return refused('invalid', problem);
  const source = skillView(store, o.from, o.version)?.skill;
  if (!source) return refused('missing', `no skill ${o.from}${o.version ? ` at version ${o.version}` : ''}`);
  if (latestSkill(store, o.name)) return refused('conflict', `a skill ${o.name} exists already`);
  return store.tx(() => {
    const kept = store.skillLibrary.add({ name: o.name, version: source.version, files: source.files, source: { kind: 'duplicated', name: source.name, version: source.version }, by: o.by, at: o.now });
    store.events.append({ type: 'library_skill.saved', data: { name: kept.name, version: kept.version, seq: kept.seq, source: kept.source, by: o.by } });
    return { ok: true as const, value: kept };
  });
}

/** Removes the user's skill `name`: refused for a built-in one, and while a work skill setting names it. Jobs that got it keep it. */
export function removeSkill(store: UserStore, o: { name: string; by: string; now: string }): LibraryChange<string> {
  if (isBuiltIn(o.name)) return refused('conflict', `${o.name} is a built-in skill: it cannot be removed`);
  if (namedSkills(workSkillSettings(store)).includes(o.name)) return refused('conflict', `a work skill setting names ${o.name}: choose another skill there first`);
  return store.tx(() => {
    if (!store.skillLibrary.remove(o.name, o.now)) return refused('missing', `no skill ${o.name}`);
    store.events.append({ type: 'library_skill.removed', data: { name: o.name, by: o.by } });
    return { ok: true as const, value: o.name };
  });
}

/** Changes which skill each kind of work gets; each skill it names must be in the library. Recorded as `work_skills.changed`. */
export function changeWorkSkills(store: UserStore, patch: WorkSkillPatch, by: string): LibraryChange<WorkSkillSettings> {
  return store.tx(() => {
    const from = workSkillSettings(store);
    const to = patchWorkSkills(from, patch);
    const missing = namedSkills(to).find((name) => !latestSkill(store, name));
    if (missing) return refused('missing', `no skill ${missing}`);
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      store.skillLibrary.setWorkSkills(to);
      store.events.append({ type: 'work_skills.changed', data: { from, to, by } });
    }
    return { ok: true as const, value: to };
  });
}

/** The newest `job.work_skill_chosen` of a job. */
const chosenOf = (store: UserStore, jobId: string): WorkSkillChosen | undefined =>
  store.events.recent(1, ['job.work_skill_chosen'], jobId)[0]?.data as WorkSkillChosen | undefined;

/** A kept version of a skill: a built-in one while this build has it, else the user's by its id. */
const versionOf = (store: UserStore, r: RequiredSkill): LibrarySkillVersion | undefined => {
  const v = r.seq === 0 ? builtInOf(r.name) : store.skillLibrary.version(r.name, r.version);
  return v?.version === r.version ? v : undefined;
};

/**
 * The skills `top` requires, and theirs, breadth first, each once, at their newest version: at most SKILL_MAX_REQUIRED. A
 * name the library has no skill of, or past the limit, is missing. `top` itself is never required again.
 */
function requiredOf(store: UserStore, top: LibrarySkillVersion): { skills: LibrarySkillVersion[]; missing: string[] } {
  const skills: LibrarySkillVersion[] = [];
  const missing: string[] = [];
  const seen = new Set([top.name]);
  const queue = skillRequires(top.files[SKILL_FILE] ?? '');
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const v = skills.length < SKILL_MAX_REQUIRED ? latestSkill(store, name) : undefined;
    if (!v) { missing.push(name); continue; }
    skills.push(v);
    queue.push(...skillRequires(v.files[SKILL_FILE] ?? ''));
  }
  return { skills, missing };
}

/** A job's work skill and the skills beside it, the work skill first: their names and files. */
export interface JobSkills { chosen: WorkSkillChosen; files: Record<string, string>; skills: { name: string; files: Record<string, string> }[] }

/**
 * The work skill of `job` and its files, with the skills it requires: the ones chosen at its first start for its kind of
 * work, while each version is there; else chosen now — by its repository's setting, the user's, else the default, and
 * each skill it requires at its newest version — and recorded as `job.work_skill_chosen`. A skill a setting names that is
 * gone, or a built-in version this build no longer has, gives the next choice: the built-in default.
 */
export function workSkillOf(store: UserStore, job: Pick<Job, 'id' | 'spec' | 'source'>): JobSkills {
  const kind = workKindOf(job.spec);
  const kept = chosenOf(store, job.id);
  if (kept?.kind === kind) {
    const v = versionOf(store, kept);
    const required = (kept.requires ?? []).map((r) => versionOf(store, r));
    if (v && required.every((r) => r !== undefined)) return { chosen: kept, files: v.files, skills: [v, ...required].map(({ name, files }) => ({ name, files })) };
  }
  const want = workSkillFor(workSkillSettings(store), job.source?.repo, kind);
  const found = latestSkill(store, want.name);
  const v = found ?? builtInOf(DEFAULT_WORK_SKILLS[kind])!;
  const required = requiredOf(store, v);
  const chosen: WorkSkillChosen = {
    kind, name: v.name, version: v.version, seq: v.seq, from: found ? want.from : 'default',
    requires: required.skills.map((r) => ({ name: r.name, version: r.version, seq: r.seq })), missing: required.missing,
  };
  store.events.append({ type: 'job.work_skill_chosen', jobId: job.id, data: { ...chosen } });
  return { chosen, files: v.files, skills: [v, ...required.skills].map(({ name, files }) => ({ name, files })) };
}
