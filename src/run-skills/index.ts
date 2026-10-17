// Run skills (issue #472, design.md "Run skills"): the text the hopper sends to the user's own AI CLI for the length of
// one run, built into the hopper. Each is the plain files of a directory here, named by a content hash over their names
// and contents, as a client release is (src/client/release.ts): the same files, the same id. It goes to the CLI on
// stdin, inside the prompt; nothing of it is written on the machine. Not a skill (src/skills/, what the hopper sets up
// for a box), and not a Claude Code skill.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseOf } from '../client/release.ts';

export const RUN_SKILL_NAMES = ['file-issue'] as const;
export type RunSkillName = (typeof RUN_SKILL_NAMES)[number];

export const RUN_SKILLS_DIR = fileURLToPath(new URL('./', import.meta.url));

export interface RunSkill {
  name: RunSkillName;
  /** 16 hex: the manifest's, as a client release's id. */
  id: string;
  /** File name → the SHA-256 (hex) of its content. */
  manifest: Record<string, string>;
  /** File name → content. */
  files: Record<string, string>;
}

/** The run skill, as its files are now. */
export function loadRunSkill(name: RunSkillName): RunSkill {
  const dir = join(RUN_SKILLS_DIR, name);
  const files = Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
  return { name, ...releaseOf(files) };
}

/** Why the skill may not run — its files are not the ones its id names —; undefined: it is whole. */
export function checkRunSkill(skill: RunSkill): string | undefined {
  return releaseOf(skill.files).id === skill.id ? undefined : `run skill ${skill.name}: its files do not match its id ${skill.id}`;
}
