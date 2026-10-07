// The detected ssh targets (design.md "Machines from the UI", issue #18): the Host aliases of
// ~/.ssh/config, the only ssh destinations the UI may attach. A pattern (`*`, `?`, `!`) is not a
// host. `Include` is followed like ssh does: a relative path is relative to the config's directory,
// `~` is the home directory, globs expand. What cannot be read is a note, never an error; no config at
// all is the usual case (issue #309: a hopper in a container has none) and says nothing.
// Hand-written (about 50 lines): the `ssh-config` package parses the same but does not follow
// Include, which is the part that needs care.
import { globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export interface SshTargets { targets: string[]; notes: string[] }

/** ssh's own limit on Include nesting. */
const MAX_DEPTH = 16;
const PATTERN = /[*?!]/;

/** `keyword args` or `keyword=args`; comments and blank lines give undefined. */
function directive(line: string): { key: string; args: string[] } | undefined {
  const text = line.replace(/#.*$/, '').trim();
  const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(text);
  if (!m) return undefined;
  return { key: m[1]!.toLowerCase(), args: m[2]!.split(/\s+/).filter(Boolean).map((a) => a.replace(/^"(.*)"$/, '$1')) };
}

export function readSshTargets(path: string): SshTargets {
  const targets: string[] = [];
  const notes: string[] = [];
  const base = dirname(path);
  const seen = new Set<string>();

  const read = (file: string, depth: number): void => {
    if (seen.has(file) || depth > MAX_DEPTH) return;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!(code === 'ENOENT' && depth === 0)) notes.push(`${file}: ${(e as Error).message}`);
      return;
    }
    for (const line of text.split('\n')) {
      const d = directive(line);
      if (d?.key === 'host') {
        for (const a of d.args) if (!PATTERN.test(a) && !targets.includes(a)) targets.push(a);
      } else if (d?.key === 'include') {
        for (const arg of d.args) {
          const expanded = arg.startsWith('~/') ? join(homedir(), arg.slice(2)) : arg;
          const pattern = isAbsolute(expanded) ? expanded : join(base, expanded);
          const files = globSync(pattern).sort();
          if (files.length === 0) notes.push(`Include ${arg} in ${file}: no file matches`);
          for (const f of files) read(f, depth + 1);
        }
      }
    }
  };

  read(path, 0);
  return { targets, notes };
}
