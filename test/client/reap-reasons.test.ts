// Why the reap kept each checkout (issue #2494), run for real: uncommitted changes (`dirty`), a stash (`stash`), commits
// no remote has (`unpushed`), each it holds named, so Work not pushed says why.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEPT_REASONS as SAID, readReap, reapArgv } from '../../src/client/reap.ts';
import { withoutUse } from '../support/reap-said.ts';
import { KEPT_REASONS } from '../../src/domain/kept-work.ts';

const JOB = 'job-2494-reasons';

let root: string;
let scratch: string;
let tree: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();

const commit = (dir: string, name: string, text: string): void => {
  writeFileSync(join(dir, name), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', name);
};

const reap = () => {
  const [file, ...args] = reapArgv(JOB, scratch);
  return withoutUse(readReap(execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 })));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jh-reap-reasons-'));
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  mkdirSync(scratch, { recursive: true });
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const main = join(root, 'main');
  git(root, 'clone', '-q', remote, main);
  git(main, 'checkout', '-q', '-b', 'main');
  commit(main, 'a.txt', 'a\n');
  git(main, 'push', '-q', 'origin', 'main');
  tree = join(scratch, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'issue-1', tree, 'origin/main');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the reap names why it kept a checkout (issue #2494)', () => {
  it('a change not committed: dirty', () => {
    writeFileSync(join(tree, 'a.txt'), 'changed\n');
    expect(reap()).toEqual({ kept: [tree], reasons: { [tree]: ['dirty'] } });
  });

  it('a stash only: stash', () => {
    writeFileSync(join(tree, 'a.txt'), 'changed\n');
    git(tree, 'stash', 'push', '-q');
    expect(reap()).toEqual({ kept: [tree], reasons: { [tree]: ['stash'] } });
  });

  it('a commit no remote has: unpushed, with its tip', () => {
    commit(tree, 'b.txt', 'b\n');
    const tip = git(tree, 'rev-parse', 'HEAD');
    expect(reap()).toEqual({ kept: [tree], tips: { [tree]: [tip] }, reasons: { [tree]: ['unpushed'] } });
  });

  it('each it holds: dirty, stash and unpushed', () => {
    commit(tree, 'b.txt', 'b\n');
    writeFileSync(join(tree, 'a.txt'), 'changed\n');
    git(tree, 'stash', 'push', '-q');
    writeFileSync(join(tree, 'c.txt'), 'c\n');
    expect(reap()).toEqual({ kept: [tree], reasons: { [tree]: ['dirty', 'stash', 'unpushed'] } });
  });

  it('names the reasons the domain knows, and no other', () => expect(SAID).toEqual(KEPT_REASONS));

  it('a reap that names no reason (a client older than this) reads as none', () => {
    expect(readReap(`hopper-kept ${tree}\nhopper-kept-why bogus ${tree}\nhopper-kept-why dirty /elsewhere\nhopper-reaped\n`)).toEqual({ kept: [tree] });
  });
});
