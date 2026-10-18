// Bundled skills (issue #1909, design.md "Bundled skills"): the ways of working the hopper ships with itself and gives
// every job through `hopper-skill`, so a job needs no workflow repository to orchestrate its work. Each is the plain
// files of a directory in `bundled/`, named by its **skill version**: a content hash over the files' names and contents,
// as a client release's id (src/client/release.ts). The same files, the same version. `SKILL.md` is what a load
// answers; another file of the skill is its asset (`sh "$HOPPER_SKILL" orchestrate FILE`).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseOf } from '../client/release.ts';

export const BUNDLED_SKILL_NAMES = ['orchestrate'] as const;
export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number];

/** Each bundled skill's catalog line. */
export const BUNDLED_LINES: Record<BundledSkillName, string> = {
  orchestrate: 'plan many steps as tasks; fan out sub-tasks; wait; finish',
};

/** The file a load of a bundled skill answers. */
export const BUNDLED_ENTRY = 'SKILL.md';

export interface BundledSkill {
  name: BundledSkillName;
  /** 16 hex: the skill version, the manifest's id. */
  version: string;
  /** File name → content. */
  files: Record<string, string>;
}

const loaded = new Map<BundledSkillName, BundledSkill>();

/** The bundled skill, as its files are now; read once. */
export function bundledSkill(name: BundledSkillName): BundledSkill {
  const kept = loaded.get(name);
  if (kept) return kept;
  // Resolved here, not at import: a browser-like test environment imports this module with a URL that is no file URL.
  const dir = join(fileURLToPath(new URL('./bundled/', import.meta.url)), name);
  const files = Object.fromEntries(readdirSync(dir).filter((n) => /^[A-Za-z0-9][\w.-]*$/.test(n)).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
  const skill = { name, version: releaseOf(files).id, files };
  loaded.set(name, skill);
  return skill;
}

export const isBundledSkill = (name: string): name is BundledSkillName => (BUNDLED_SKILL_NAMES as readonly string[]).includes(name);

/** What a load answers: the entry, or the file `file` names, headed by its version; or what is wrong. */
export function bundledText(skill: BundledSkill, file?: string): { text: string } | { no: string } {
  const name = file ?? BUNDLED_ENTRY;
  const text = skill.files[name];
  if (text === undefined) return { no: `the skill ${skill.name} has no file ${name}. It has: ${Object.keys(skill.files).join(', ')}.` };
  return { text: `skill ${skill.name}, version ${skill.version}${file ? `, file ${file}` : ''}\n\n${text}` };
}
