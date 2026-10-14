// What's new fragments (issue #824, AGENTS.md "What's new"): a change adds its line in a file of its own in
// whats-new/, so two open pull requests never edit the same lines of WHATS-NEW.md.
//
//   node scripts/whats-new.ts assemble        # move every fragment's lines into WHATS-NEW.md, delete the fragments
//   node scripts/whats-new.ts check <base>    # the What's new of HEAD against the commit <base>: exit 1 on a problem
//
// `assemble` runs on main as an ordinary pull request, and reaches dev with the next batch run, before a
// promotion to beta (scripts/promote.sh refuses a commit with fragments). `check` runs on every pull request into main (.github/workflows/pr.yml), not on a
// promotion: it refuses a line added to WHATS-NEW.md directly, a released line changed, and a fragment with a wrong
// name.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assemble, isFragment, type Notes, problems, readNotes, WHATS_NEW_DIR, WHATS_NEW_FILE } from '../src/update/whats-new.ts';

const ROOT = process.cwd();

const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const show = (commit: string, path: string): string => {
  try {
    return git('show', `${commit}:${path}`);
  } catch {
    return '';
  }
};

/** What's new at a commit of the repository in the working directory. */
function notesAt(commit: string): Notes {
  const names = git('ls-tree', '--name-only', commit, `${WHATS_NEW_DIR}/`).split('\n').filter((p) => p.endsWith('.md'));
  return {
    file: show(commit, WHATS_NEW_FILE),
    fragments: names.map((p) => ({ name: p.slice(WHATS_NEW_DIR.length + 1), text: show(commit, p) })),
  };
}

const [command, base] = process.argv.slice(2);
if (command === 'assemble') {
  const notes = readNotes(ROOT);
  const done = notes.fragments.filter((f) => isFragment(f.name));
  if (done.length === 0) {
    console.log(`no fragments in ${WHATS_NEW_DIR}/: nothing to assemble`);
  } else {
    writeFileSync(resolve(ROOT, WHATS_NEW_FILE), assemble(notes));
    for (const f of done) rmSync(join(ROOT, WHATS_NEW_DIR, f.name));
    console.log(`moved ${done.length} fragment(s) into ${WHATS_NEW_FILE}: ${done.map((f) => f.name).join(', ')}`);
  }
} else if (command === 'check' && base) {
  const found = problems(notesAt(base), notesAt('HEAD'));
  for (const p of found) console.error(`what's new: ${p}`);
  if (found.length > 0) process.exit(1);
  console.log(`what's new: no problems against ${base}`);
} else {
  console.error('usage: node scripts/whats-new.ts assemble | check <base commit>');
  process.exit(2);
}
