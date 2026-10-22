// Issue #2459: a checkpoint whose commits the remote holds, though the worktree's remote branches do not say so (a push
// through the hopper need not move them), is restored on the job's branch at its pushed commit: only the work not
// committed comes back as uncommitted changes. Run for real, as checkpoint.test.ts.
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpointArgv, readCheckpoint, restoreArgv, restoreCommand } from '../../src/client/checkpoint.ts';

const JOB = 'job-2459-abcdef';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

let root: string;
let remote: string;
let server: Server | undefined;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
const run = (argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
  execFile(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...ENV, ...env }, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
});

function jobClone(machine: string): string {
  const dir = join(root, machine, 'work', '.worktrees', '@scratch', JOB, 'repo');
  mkdirSync(join(dir, '..'), { recursive: true });
  git(root, 'clone', '-q', remote, dir);
  return dir;
}

async function serve(parts: Record<string, Buffer>): Promise<string> {
  server = createServer((req, res) => {
    const part = /^\/job\/checkpoint\/(patch|session)$/.exec(req.url ?? '')?.[1];
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    if (!part || !parts[part]) return void res.writeHead(404).end();
    res.writeHead(200).end(parts[part]);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-pushed-')));
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = mkdtempSync(join(root, 'seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'a');
  git(seed, 'push', '-q', remote, 'main');
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('restoring a checkpoint whose head the remote holds (issue #2459)', () => {
  it('checks out the job\'s branch at the pushed commit, and only the work not committed is uncommitted', async () => {
    // The first machine: a commit pushed, and no remote branch of the worktree says so, as after a push through the hopper.
    const wt = jobClone('one');
    git(wt, 'checkout', '-q', '-b', 'hopper/2459');
    writeFileSync(join(wt, 'd.txt'), 'pushed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'pushed work');
    git(wt, 'push', '-q', remote, 'HEAD:refs/heads/hopper/2459');
    if (git(wt, 'for-each-ref', 'refs/remotes/origin/hopper/2459')) git(wt, 'update-ref', '-d', 'refs/remotes/origin/hopper/2459');
    const head = git(wt, 'rev-parse', 'HEAD');
    writeFileSync(join(wt, 'a.txt'), 'a\nchanged\n');
    writeFileSync(join(wt, 'new.txt'), 'untracked\n');
    const home = join(root, 'one-home');
    mkdirSync(join(home, '.claude', 'projects', 'some-dir'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'some-dir', `${SESSION}.jsonl`), '{"type":"user"}\n');
    const read = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION), wt, { HOME: home }));
    if (!read || !('taken' in read)) throw new Error('no checkpoint');
    const k = read.taken;
    // The worktree's remote branches do not say it is pushed: the base is where it left the default branch.
    expect(k.base).not.toBe(head);
    expect(k.commits).toEqual([expect.stringContaining('pushed work')]);

    const url = await serve({ patch: gunzipSync(k.patch), session: gunzipSync(k.session!) });
    writeFileSync(join(root, 'token'), 'tok');
    const there = jobClone('two');
    git(there, 'checkout', '-q', '--detach', 'origin/main');
    const out = await run(restoreArgv({ base: k.base, branch: 'hopper/2459', pushed: head, session: SESSION, hasSession: true }), there,
      { HOME: join(root, 'two-home'), CLAUDE_CONFIG_DIR: '', HOPPER_URL: url, HOPPER_TOKEN_FILE: join(root, 'token') });
    expect(out.trim().split('\n').at(-1)).toBe('restored');
    expect(git(there, 'symbolic-ref', '--short', 'HEAD')).toBe('hopper/2459');
    expect(git(there, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(there, 'status', '--porcelain').split('\n').sort()).toEqual([' M a.txt', '?? new.txt']);
    expect(readFileSync(join(there, 'd.txt'), 'utf8')).toBe('pushed\n');
    expect(readFileSync(join(there, 'a.txt'), 'utf8')).toBe('a\nchanged\n');
  });

  it('as typed into a pane: the pushed commit is one more argument', () => {
    const c = restoreCommand({ base: 'b'.repeat(40), branch: 'hopper/2459', pushed: 'c'.repeat(40), session: SESSION, hasSession: true });
    expect(c).toContain(`'${'b'.repeat(40)}' 'hopper/2459' '${SESSION}' '1' '${'c'.repeat(40)}'`);
  });
});
