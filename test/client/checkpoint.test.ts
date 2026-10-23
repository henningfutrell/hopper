// A job's checkpoint (issue #921), run for real: the capture script reads a real git worktree in the job's scratch dir and
// the agent session in a real config dir; the restore script, as the new pane's shell runs it, rebuilds the work in a
// fresh clone on "another machine", getting the parts from a loopback server that stands in for the hopper.
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpointArgv, checkpointOf, readCheckpoint, RESTORE_NO_WAY, RESTORE_REMOTE_OUT_OF_REACH, restoreArgv, restoreCommand, restoredInPart, restoreOutcome } from '../../src/client/checkpoint.ts';

const JOB = 'job-921-abcdef';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

let root: string;
let remote: string;
let server: Server | undefined;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();

const run = (argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
  execFile(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...ENV, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`${err.message}\n${stderr}`));
    resolve(stdout);
  });
});

/** A clone of the remote in a job's scratch dir under `machine`, as a job worktree is placed. */
function jobClone(machine: string): string {
  const dir = join(root, machine, 'work', '.worktrees', '@scratch', JOB, 'repo');
  mkdirSync(join(dir, '..'), { recursive: true });
  git(root, 'clone', '-q', remote, dir);
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-')));
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = mkdtempSync(join(root, 'seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'a');
  git(seed, 'push', '-q', remote, 'main');
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** On the first machine: a branch with one commit pushed, one not, a changed file, a new file, the session file. */
async function workOnFirstMachine(): Promise<{ wt: string; home: string; pushed: string }> {
  const wt = jobClone('one');
  git(wt, 'checkout', '-q', '-b', 'hopper/921');
  writeFileSync(join(wt, 'b.txt'), 'pushed\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'pushed work');
  git(wt, 'push', '-q', 'origin', 'hopper/921');
  const pushed = git(wt, 'rev-parse', 'HEAD');
  writeFileSync(join(wt, 'c.txt'), 'committed, not pushed\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'not pushed yet');
  writeFileSync(join(wt, 'a.txt'), 'a\nchanged\n');
  writeFileSync(join(wt, 'new.txt'), 'untracked\n');
  // A link to shared dependencies (issue #410) is no work of the job's.
  symlinkSync(join(root, 'deps'), join(wt, 'node_modules'));
  const home = join(root, 'one-home');
  mkdirSync(join(home, '.claude', 'projects', 'some-dir'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'some-dir', `${SESSION}.jsonl`), '{"type":"user","message":"hello"}\n');
  return { wt, home, pushed };
}

describe('taking a checkpoint', () => {
  it('copies the work not pushed as a patch on the pushed branch, the commits not pushed, and the session', async () => {
    const { wt, home, pushed } = await workOnFirstMachine();
    const out = await run(checkpointArgv(JOB, wt, SESSION), wt, { HOME: home, CLAUDE_CONFIG_DIR: '' });
    const read = readCheckpoint(out);
    if (!read || !('taken' in read)) throw new Error(`no checkpoint: ${out}`);
    const k = read.taken;
    expect(k.branch).toBe('hopper/921');
    expect(k.base).toBe(pushed);
    expect(k.head).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(k.commits).toEqual([expect.stringMatching(/^[0-9a-f]{7,} not pushed yet$/)]);
    const patch = gunzipSync(k.patch).toString('utf8');
    expect(patch).toContain('c.txt');
    expect(patch).toContain('+changed');
    expect(patch).toContain('+untracked');
    expect(patch).not.toContain('node_modules');
    expect(patch).not.toContain('b.txt');
    expect(gunzipSync(k.session!).toString('utf8')).toContain('"hello"');
    // Nothing of the job's own git state moved: its index is as it was.
    expect(git(wt, 'status', '--porcelain')).toContain('?? new.txt');
  });

  // Issue #2302, part 6: the session's subagent logs go with it, for the token ledger, and only while they fit.
  it('carries the session\'s subagent logs, one after the other, and leaves them out when they do not fit', async () => {
    const { wt, home } = await workOnFirstMachine();
    const dir = join(home, '.claude', 'projects', 'some-dir', SESSION, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-a1.jsonl'), '{"agent":"one"}');
    writeFileSync(join(dir, 'agent-a2.jsonl'), '{"agent":"two"}\n');
    writeFileSync(join(dir, 'agent-a2.meta.json'), '{"meta":true}');
    const read = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION), wt, { HOME: home, CLAUDE_CONFIG_DIR: '' }));
    if (!read || !('taken' in read)) throw new Error('no checkpoint');
    expect(gunzipSync(read.taken.subagents!).toString('utf8').split('\n').filter(Boolean)).toEqual(['{"agent":"one"}', '{"agent":"two"}']);
    expect(gunzipSync(read.taken.session!).toString('utf8')).not.toContain('agent');
    const sized = read.taken.patch.length + read.taken.session!.length;
    const tight = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION, sized), wt, { HOME: home, CLAUDE_CONFIG_DIR: '' }));
    expect(tight && 'taken' in tight && tight.taken.session && !tight.taken.subagents).toBe(true);
  });

  it('says why it took none: the worktree gone, or too large', async () => {
    const { wt, home } = await workOnFirstMachine();
    const gone = readCheckpoint(await run(checkpointArgv(JOB, `${wt}-gone`, SESSION), root, { HOME: home }));
    expect(gone).toEqual({ none: expect.stringContaining('is not there') });
    const large = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION, 10), wt, { HOME: home }));
    expect(large).toEqual({ none: expect.stringContaining('too large') });
  });

  it('is never asked of a path outside the job\'s scratch dir, nor with a session id that is not one', () => {
    expect(checkpointOf({ jobId: JOB, worktree: '/home/u/work/repo', session: SESSION })).toMatch(/scratch dir/);
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.worktrees/@scratch/${JOB}/../../etc`, session: SESSION })).toMatch(/scratch dir/);
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.worktrees/@scratch/${JOB}/repo`, session: '$(rm -rf ~)' })).toMatch(/session/);
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.worktrees/@scratch/${JOB}/repo`, session: SESSION })).toEqual(expect.arrayContaining([JOB, SESSION]));
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.worktrees/repo/${JOB}`, session: SESSION })).toEqual(expect.arrayContaining([JOB, SESSION]));
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.worktrees/repo/${JOB}/../x`, session: SESSION })).toMatch(/worktree/);
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.worktrees/repo/other`, session: SESSION })).toMatch(/worktree/);
  });

  it('reads a job that started before the layout of issue #1188 in its worktree there (issue #1353)', async () => {
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.hopper-scratch/${JOB}/repo`, session: SESSION })).toEqual(expect.arrayContaining([JOB, SESSION]));
    expect(checkpointOf({ jobId: JOB, worktree: `/w/workspace/worktrees/repo-${JOB}`, session: SESSION })).toEqual(expect.arrayContaining([JOB, SESSION]));
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.hopper-scratch/other/repo`, session: SESSION })).toMatch(/worktree/);
    expect(checkpointOf({ jobId: JOB, worktree: `/w/.hopper-scratch/${JOB}/../../etc`, session: SESSION })).toMatch(/worktree/);
    expect(checkpointOf({ jobId: JOB, worktree: `/w/workspace/worktrees/repo-other`, session: SESSION })).toMatch(/worktree/);
    const { home } = await workOnFirstMachine();
    for (const at of [join(root, 'old', '.hopper-scratch', JOB, 'repo'), join(root, 'old', 'workspace', 'worktrees', `repo-${JOB}`)]) {
      mkdirSync(join(at, '..'), { recursive: true });
      git(root, 'clone', '-q', remote, at);
      const read = readCheckpoint(await run(checkpointArgv(JOB, at, SESSION), at, { HOME: home, CLAUDE_CONFIG_DIR: '' }));
      expect(read && 'taken' in read).toBe(true);
    }
  });

  it('the script refuses a path with .. in it, whatever its layout', async () => {
    await expect(run(checkpointArgv(JOB, `/w/.hopper-scratch/${JOB}/../../etc`, SESSION), root, {})).rejects.toThrow(/not the job's worktree/);
  });
});

describe('restoring a checkpoint on another machine', () => {
  const runBoth = (argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ out: string; err: string }> => new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...ENV, ...env }, encoding: 'utf8', timeout: 60000 }, (e, out, err) => (e ? reject(e) : resolve({ out, err })));
  });

  async function serve(parts: Record<string, Buffer>, token: string): Promise<string> {
    server = createServer((req, res) => {
      const part = /^\/job\/checkpoint\/(patch|session)$/.exec(req.url ?? '')?.[1];
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      if (!part || !parts[part]) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(parts[part]);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  it('checks out the base on the branch, applies the patch, and puts the session where the agent finds it here', async () => {
    const { wt, home } = await workOnFirstMachine();
    const read = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION), wt, { HOME: home }));
    if (!read || !('taken' in read)) throw new Error('no checkpoint');
    const k = read.taken;
    const url = await serve({ patch: gunzipSync(k.patch), session: gunzipSync(k.session!) }, 'tok');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'tok');

    // Another machine: a fresh worktree, detached at the default branch, as a job worktree is made.
    const there = jobClone('two');
    git(there, 'checkout', '-q', '--detach', 'origin/main');
    const home2 = join(root, 'two-home');
    const out = await run(restoreArgv({ base: k.base, branch: k.branch, session: SESSION, hasSession: true }), there,
      { HOME: home2, CLAUDE_CONFIG_DIR: '', HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim().split('\n').at(-1)).toBe('restored');
    expect(git(there, 'symbolic-ref', '--short', 'HEAD')).toBe('hopper/921');
    expect(git(there, 'rev-parse', 'HEAD')).toBe(k.base);
    expect(readFileSync(join(there, 'a.txt'), 'utf8')).toBe('a\nchanged\n');
    expect(readFileSync(join(there, 'c.txt'), 'utf8')).toBe('committed, not pushed\n');
    expect(readFileSync(join(there, 'new.txt'), 'utf8')).toBe('untracked\n');
    const dir = realpathSync(there).replace(/[^A-Za-z0-9]/g, '-');
    expect(readFileSync(join(home2, '.claude', 'projects', dir, `${SESSION}.jsonl`), 'utf8')).toContain('"hello"');
  });

  it('keeps a worktree that holds changes already: the job\'s own work is never overwritten', async () => {
    const { wt, home } = await workOnFirstMachine();
    const read = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION), wt, { HOME: home }));
    if (!read || !('taken' in read)) throw new Error('no checkpoint');
    const url = await serve({ patch: gunzipSync(read.taken.patch), session: gunzipSync(read.taken.session!) }, 'tok');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'tok');
    const out = await run(restoreArgv({ base: read.taken.base, branch: read.taken.branch, session: SESSION, hasSession: true }), wt,
      { HOME: home, CLAUDE_CONFIG_DIR: '', HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim().split('\n').at(-1)).toBe('kept');
    expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toBe('untracked\n');
  });

  // Issue #2428: a patch that conflicts with the restored tree is applied file by file, and the job goes on.
  it('applies a patch that does not apply whole file by file: says each file left out, and keeps the whole patch', async () => {
    const { wt, home } = await workOnFirstMachine();
    const read = readCheckpoint(await run(checkpointArgv(JOB, wt, SESSION), wt, { HOME: home }));
    if (!read || !('taken' in read)) throw new Error('no checkpoint');
    const k = read.taken;
    const patch = gunzipSync(k.patch);
    const url = await serve({ patch, session: gunzipSync(k.session!) }, 'tok');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'tok');
    // The base as the other machine has it: a.txt differs there, and new.txt is there already, so the patch conflicts.
    const there = jobClone('two');
    git(there, 'fetch', '-q', 'origin', 'hopper/921');
    git(there, 'checkout', '-q', '--detach', k.base);
    writeFileSync(join(there, 'a.txt'), 'other\n');
    writeFileSync(join(there, 'new.txt'), 'other\n');
    git(there, 'add', '.');
    git(there, 'commit', '-q', '-m', 'drift');
    const drifted = git(there, 'rev-parse', 'HEAD');
    git(there, 'checkout', '-q', '--detach', 'origin/main');
    const { out, err } = await runBoth(restoreArgv({ base: drifted, branch: k.branch, session: SESSION, hasSession: true }), there,
      { HOME: join(root, 'two-home'), CLAUDE_CONFIG_DIR: '', HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim().split('\n').at(-1)).toBe('partly');
    expect(readFileSync(join(there, 'a.txt'), 'utf8')).toBe('other\n');
    expect(readFileSync(join(there, 'new.txt'), 'utf8')).toBe('other\n');
    expect(readFileSync(join(there, 'c.txt'), 'utf8')).toBe('committed, not pushed\n');
    const said = restoredInPart(err);
    expect(said.leftOut.sort()).toEqual(['a.txt', 'new.txt']);
    expect(said.patch).toBe(git(there, 'rev-parse', '--path-format=absolute', '--git-path', 'hopper-checkpoint.patch'));
    expect(readFileSync(said.patch!)).toEqual(patch);
    expect(readFileSync(`${said.patch}.left-out`, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'new.txt']);
    expect(git(there, 'status', '--porcelain')).not.toContain('hopper-checkpoint');
    const dir = realpathSync(there).replace(/[^A-Za-z0-9]/g, '-');
    expect(readFileSync(join(root, 'two-home', '.claude', 'projects', dir, `${SESSION}.jsonl`), 'utf8')).toContain('"hello"');
  });

  it('fails, saying why, when the hopper refuses the parts', async () => {
    const there = jobClone('two');
    const url = await serve({}, 'other');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'tok');
    const out = await run(restoreArgv({ base: 'a'.repeat(40), session: SESSION, hasSession: false }), there, { HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim()).toBe('failed');
    expect(existsSync(join(there, 'a.txt'))).toBe(true);
  });

  // Issue #2639: a base it cannot fetch because the remote does not answer is not a base gone from the remote.
  it('with the remote out of reach: fails, saying the remote is out of reach, not that the base is not on it', async () => {
    const there = jobClone('two');
    git(there, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    const url = await serve({ patch: Buffer.from('') }, 'tok');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'tok');
    const { out, err } = await runBoth(restoreArgv({ base: 'a'.repeat(40), branch: 'hopper/921', session: SESSION, hasSession: false }), there,
      { HOME: join(root, 'two-home'), CLAUDE_CONFIG_DIR: '', HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim()).toBe('failed');
    expect(err).toContain(RESTORE_REMOTE_OUT_OF_REACH);
    expect(err).not.toContain('is not on the remote');
  });

  it('with the remote in reach and the base not on it: fails, saying the base is not on the remote', async () => {
    const there = jobClone('two');
    const url = await serve({ patch: Buffer.from('') }, 'tok');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'tok');
    const { out, err } = await runBoth(restoreArgv({ base: 'a'.repeat(40), session: SESSION, hasSession: false }), there,
      { HOME: join(root, 'two-home'), CLAUDE_CONFIG_DIR: '', HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim()).toBe('failed');
    expect(err).toContain(`the checkpoint's base ${'a'.repeat(40)} is not on the remote`);
    expect(err).not.toContain(RESTORE_REMOTE_OUT_OF_REACH);
  });

  // Issue #2316: the restore names what of the job's way to the hopper is missing, and waits a moment for a token file.

  it('with no HOPPER_URL: fails at once, saying the job has no way to the hopper and what is missing', async () => {
    const there = jobClone('two');
    const { HOPPER_URL: _url, ...env } = process.env;
    const { out, err } = await runBoth(restoreArgv({ base: 'a'.repeat(40), session: SESSION, hasSession: false }), there, { ...env, HOPPER_URL: '', HOPPER_TOKEN_FILE: '' });
    expect(out.trim()).toBe('failed');
    expect(err).toContain(RESTORE_NO_WAY);
    expect(err).toContain('HOPPER_URL is not set');
  });

  it('with a token file not there: waits for it a moment, then fails, saying the job has no way to the hopper', async () => {
    const there = jobClone('two');
    const at = Date.now();
    const { out, err } = await runBoth(restoreArgv({ base: 'a'.repeat(40), session: SESSION, hasSession: false }), there, { HOPPER_URL: 'http://127.0.0.1:9', HOPPER_TOKEN_FILE: join(root, 'no-token') });
    expect(out.trim()).toBe('failed');
    expect(err).toContain(RESTORE_NO_WAY);
    expect(err).toContain('HOPPER_TOKEN_FILE is not readable');
    expect(Date.now() - at).toBeGreaterThanOrEqual(4000);
  }, 30000);

  it('with a token file placed a moment late: goes on with it', async () => {
    const there = jobClone('two');
    const url = await serve({}, 'other');
    const tokenFile = join(root, 'late-token');
    setTimeout(() => writeFileSync(tokenFile, 'tok'), 1500);
    const { out, err } = await runBoth(restoreArgv({ base: 'a'.repeat(40), session: SESSION, hasSession: false }), there, { HOPPER_URL: url, HOPPER_TOKEN_FILE: tokenFile });
    expect(out.trim()).toBe('failed');
    expect(err).not.toContain(RESTORE_NO_WAY);
    expect(err).toContain('could not get the checkpoint\'s patch');
  }, 30000);

  it('as typed into a pane: one line, its outcome said in two printf words', () => {
    const command = restoreCommand({ base: 'a'.repeat(40), branch: "it's", session: SESSION, hasSession: true });
    expect(command).not.toContain('\n');
    expect(command).toMatch(/printf 'hopper-restore-%s\\n' "\$\{o:-failed\}"$/);
    expect(restoreOutcome('$ o=$(sh -c …)\nhopper-restore-restored\n$ ')).toBe('restored');
    expect(restoreOutcome('hopper-restore-kept')).toBe('kept');
    expect(restoreOutcome('hopper-restore-partly')).toBe('partly');
    expect(restoreOutcome('nothing yet')).toBeUndefined();
  });
});
