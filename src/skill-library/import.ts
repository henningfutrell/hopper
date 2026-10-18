// Importing a library skill from a GitHub repository, and refreshing it (issue #1911, design.md "Importing a skill"): the
// files of a folder of a repository, at a ref it follows, read with the user's own GitHub connection and kept as a version
// of the user's skill, as an edit keeps one. A refresh reads the same folder at the same ref again and keeps a new version
// only when the files changed; each import is a `library_skill.saved` with its source, and each refresh a
// `library_skill.refreshed`. A skill a person edited since its import is not refreshed: the refresh would drop the edit.
import { releaseOf } from '../client/release.ts';
import { IMPORT_DEFAULT_REF, importedName, importPathOf, skillFilesProblem, skillNameProblem, type LibrarySkillVersion } from '../domain/skill-library.ts';
import type { UserStore } from '../domain/store.ts';
import type { SkillFolder, SkillSourceGitHub } from './github.ts';
import { latestSkill, type LibraryChange } from './index.ts';

/** The reader of `repo`'s folders, with the account of the repository; or why there is none (GitHub not connected). */
export type SkillSource = (repo: string) => SkillSourceGitHub | { problem: string };

type Read = LibraryChange<Extract<SkillFolder, { commit: string }>>;

/** The folder's files, or the refusal: no connection (conflict), no folder (missing), no skill (invalid). GitHub's failure throws. */
async function read(source: SkillSource, repo: string, path: string, ref: string): Promise<Read> {
  const github = source(repo);
  if ('problem' in github) return { ok: false, code: 'conflict', error: github.problem };
  const found = await github.read(repo, path, ref);
  if ('problem' in found) return { ok: false, code: found.missing ? 'missing' : 'invalid', error: found.problem };
  const problem = skillFilesProblem(found.files);
  return problem ? { ok: false, code: 'invalid', error: problem } : { ok: true, value: found };
}

/** Imports the folder `path` of `repo` at `ref` (the default branch unless named) as a new skill `name` (the folder's name unless named). */
export async function importSkill(store: UserStore, source: SkillSource, o: { repo: string; path: string; ref?: string; name?: string; by: string; now: string }): Promise<LibraryChange<LibrarySkillVersion>> {
  const at = importPathOf(o.path);
  if ('problem' in at) return { ok: false, code: 'invalid', error: at.problem };
  const name = o.name ?? importedName(o.repo, at.path);
  const problem = skillNameProblem(name);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (latestSkill(store, name)) return { ok: false, code: 'conflict', error: `a skill ${name} exists already: refresh it, or import under another name` };
  const ref = o.ref ?? IMPORT_DEFAULT_REF;
  const found = await read(source, o.repo, at.path, ref);
  if (!found.ok) return found;
  return store.tx(() => {
    if (latestSkill(store, name)) return { ok: false as const, code: 'conflict' as const, error: `a skill ${name} exists already` };
    const kept = store.skillLibrary.add({
      name, version: releaseOf(found.value.files).id, files: found.value.files,
      source: { kind: 'imported', repo: o.repo, path: at.path, ref, commit: found.value.commit }, by: o.by, at: o.now,
    });
    store.events.append({ type: 'library_skill.saved', data: { name, version: kept.version, seq: kept.seq, source: kept.source, by: o.by } });
    return { ok: true as const, value: kept };
  });
}

/** Reads an imported skill's folder again at the ref it follows: a new version when its files changed. Recorded either way. */
export async function refreshSkill(store: UserStore, source: SkillSource, o: { name: string; by: string; now: string }): Promise<LibraryChange<LibrarySkillVersion>> {
  const last = latestSkill(store, o.name);
  if (!last) return { ok: false, code: 'missing', error: `no skill ${o.name}` };
  if (last.source.kind === 'built-in') return { ok: false, code: 'conflict', error: `${o.name} is a built-in skill: it ships with the hopper` };
  if (last.source.kind !== 'imported') {
    const imported = store.skillLibrary.versions(o.name).some((v) => v.source.kind === 'imported');
    return { ok: false, code: 'conflict', error: imported ? `${o.name} was edited since its import: a refresh would drop the edit; import the folder under another name` : `${o.name} was not imported from a repository` };
  }
  const { repo, path, ref } = last.source;
  const found = await read(source, repo, path, ref);
  if (!found.ok) return found;
  const version = releaseOf(found.value.files).id;
  return store.tx(() => {
    const newest = store.skillLibrary.versions(o.name)[0];
    if (newest?.seq !== last.seq) return { ok: false as const, code: 'conflict' as const, error: `${o.name} changed while it was read: refresh it again` };
    const changed = version !== last.version;
    const kept = changed
      ? store.skillLibrary.add({ name: o.name, version, files: found.value.files, source: { kind: 'imported', repo, path, ref, commit: found.value.commit }, by: o.by, at: o.now })
      : last;
    if (changed) store.events.append({ type: 'library_skill.saved', data: { name: o.name, version, seq: kept.seq, source: kept.source, by: o.by } });
    store.events.append({ type: 'library_skill.refreshed', data: { name: o.name, repo, path, ref, commit: found.value.commit, version, changed, by: o.by } });
    return { ok: true as const, value: kept };
  });
}
