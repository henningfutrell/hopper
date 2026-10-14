// The lines of a job's push (issue #1096, design.md "The shrink guard"), in the hopper's mirror: before a push reaches GitHub, the base branch and the
// branch's head before the push are fetched into the mirror when it lacks them, and the push's own pack is indexed in a
// quarantine — an object directory of its own beside the mirror's, removed after —, so nothing a job pushes enters the
// mirror unless GitHub takes it. A push whose merge base with the base branch is the head's: it brings nothing of the base
// branch in, and is not judged. Else each file the push or the branch changes is counted in lines at four commits: where
// the branch's change starts, its head, the base branch as brought in, and the push. `git diff --numstat` against the
// empty tree counts them, and fetches the blobs it needs in one batch.
import { mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { PushFileLines } from '../domain/shrink-guard.ts';
import { githubTraffic, type GitHubTraffic } from '../github-limiter/traffic.ts';
import { BRANCH, gitEnv, mirrorPathOf, readyMirror, REPO, runGit, said, TIMEOUT_MS, type GitRemote, type GitRun } from './mirrors.ts';

/** A job's push as the shrink guard reads it (issue #1096): its base branch, the ref's old and new commit, its pack. */
export interface PushToCount { base: string; old: string; new: string; pack: Buffer }

/** Whether the push brings in its base branch, and when it does, each changed file's lines (issue #1096). */
export type PushLines = { brings: false } | { brings: true; files: PushFileLines[] };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** git with `input` on its stdin (a push's pack, issue #1096). */
export const runGitWithInput = (args: string[], env: Record<string, string>, input: Buffer): ReturnType<GitRun> => new Promise((resolve) => {
  const child = execFile('git', args, { env: { ...process.env, ...env }, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
    const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (e && code === -1 ? e.message : '')) });
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input);
});

/** The lines of a job's push to `repo` before it reaches GitHub; undefined: git cannot say. `remote` is asked each time: this is no sync pass's fetch. */
export type CountPushLines = (repo: string, remote: () => Promise<GitRemote>, push: PushToCount) => Promise<PushLines | undefined>;

/** The user's mirrors under `dir`, as `createGitMirrors` keeps them. */
export function createPushLines(o: { dir: string; log(line: string): void; traffic?: GitHubTraffic; git?: GitRun }): CountPushLines {
  const traffic = o.traffic ?? githubTraffic;
  const git = o.git ?? runGit;
  return async (repo, remote, push) => {
    if (!REPO.test(repo) || repo.split('/').some((p) => p.startsWith('.')) || !BRANCH.test(push.base) || !SHA.test(push.old) || !SHA.test(push.new)) return undefined;
    const problem = (why: string): undefined => { o.log(`hopper: git mirror of ${repo}: the lines of a push: ${why}`); return undefined; };
    let r: GitRemote;
    try { r = await remote(); } catch (e) { return problem(`no credential to fetch with: ${(e as Error).message}`); }
    const env = gitEnv(r);
    const path = mirrorPathOf(o.dir, repo);
    const notReady = await readyMirror(git, path, r.url, env);
    if (notReady) return problem(notReady);
    const run = (args: string[], more: Record<string, string> = {}) => git(['--git-dir', path, ...args], { ...env, ...more });
    const listed = await run(['ls-remote', 'origin', `refs/heads/${push.base}`]);
    const base = listed.stdout.split(/\s/)[0] ?? '';
    if (listed.code !== 0 || !SHA.test(base)) return problem(listed.code !== 0 ? said(listed) : `no branch ${push.base}`);
    const missing: string[] = [];
    for (const oid of [base, push.old]) if ((await run(['cat-file', '-e', `${oid}^{commit}`])).code !== 0) missing.push(oid);
    if (missing.length > 0) {
      traffic.gitFetch(repo);
      const fetched = await run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', 'origin', ...missing]);
      if (fetched.code !== 0) return problem(said(fetched));
    }
    const quarantine = join(path, `hopper-quarantine-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(quarantine, 'pack'), { recursive: true, mode: 0o700 });
    const q = { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(path, 'objects') };
    const inQ = (args: string[], more: Record<string, string> = {}) => run(args, { ...q, ...more });
    try {
      if (push.pack.length > 0) {
        const indexed = await runGitWithInput(['--git-dir', path, 'index-pack', '--stdin', '--fix-thin'], { ...env, ...q }, push.pack);
        if (indexed.code !== 0) return problem(`index-pack: ${said(indexed)}`);
      }
      const mergeBase = async (oid: string) => { const m = await inQ(['merge-base', oid, base]); return m.code === 0 ? m.stdout.trim() : undefined; };
      const [start, brought] = [await mergeBase(push.old), await mergeBase(push.new)];
      if (!start || !brought) return problem('no merge base with the base branch');
      if (start === brought) return { brings: false };
      const changed = new Set<string>();
      for (const [a, b] of [[brought, push.new], [push.old, push.new]] as const) {
        const d = await inQ(['diff', '--name-only', '-z', '--no-renames', a, b]);
        if (d.code !== 0) return problem(`diff: ${said(d)}`);
        for (const f of d.stdout.split('\0')) if (f) changed.add(f);
      }
      const files = [...changed];
      if (files.length === 0) return { brings: true, files: [] };
      const empty = await inQ(['hash-object', '-t', 'tree', '/dev/null']);
      if (empty.code !== 0) return problem(said(empty));
      const counts: Record<'start' | 'head' | 'base' | 'pushed', Map<string, number | 'binary'>> = { start: new Map(), head: new Map(), base: new Map(), pushed: new Map() };
      for (const [at, oid] of [['start', start], ['head', push.old], ['base', brought], ['pushed', push.new]] as const) {
        const n = await inQ(['diff', '--numstat', '-z', '--no-renames', empty.stdout.trim(), oid, '--', ...files], { GIT_LITERAL_PATHSPECS: '1' });
        if (n.code !== 0) return problem(`numstat: ${said(n)}`);
        for (const entry of n.stdout.split('\0')) {
          const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
          if (m) counts[at].set(m[3]!, m[1] === '-' ? 'binary' : Number(m[1]));
        }
      }
      const out: PushFileLines[] = [];
      for (const path of files) {
        const of = (at: keyof typeof counts) => counts[at].get(path);
        // A binary file has no lines to count.
        if ((['start', 'head', 'base', 'pushed'] as const).some((at) => of(at) === 'binary')) continue;
        const line = (at: keyof typeof counts) => { const v = of(at); return typeof v === 'number' ? { [at]: v } : {}; };
        out.push({ path, ...line('start'), ...line('head'), ...line('base'), ...line('pushed') });
      }
      return { brings: true, files: out };
    } finally {
      rmSync(quarantine, { recursive: true, force: true });
    }
  };
}
