// Whether a job's push holds a requirements file (issue #2555, design.md "Push requirements"), in the hopper's mirror, as the
// shrink guard reads a push (push-lines.ts): the base branch is fetched into the mirror when it lacks it, the push's own pack
// is indexed in a quarantine, removed after, and the pushed commit's tree is listed. Nothing a job pushes enters the mirror.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requirementsFileDir } from '../domain/push-requirements.ts';
import { githubTraffic, type GitHubTraffic } from '../github-limiter/traffic.ts';
import { BRANCH, gitEnv, mirrorPathOf, readyMirror, REPO, runGit, said, type GitRemote, type GitRun } from './mirrors.ts';
import { runGitWithInput } from './push-lines.ts';

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Whether the commit `new` of a push to `repo` holds a requirements file; undefined: git cannot say. */
export type HoldsRequirements = (repo: string, remote: () => Promise<GitRemote>, push: { base: string; new: string; pack: Buffer }) => Promise<boolean | undefined>;

export function createHoldsRequirements(o: { dir: string; log(line: string): void; traffic?: GitHubTraffic; git?: GitRun }): HoldsRequirements {
  const traffic = o.traffic ?? githubTraffic;
  const git = o.git ?? runGit;
  return async (repo, remote, push) => {
    if (!REPO.test(repo) || repo.split('/').some((p) => p.startsWith('.')) || !BRANCH.test(push.base) || !SHA.test(push.new)) return undefined;
    const problem = (why: string): undefined => { o.log(`hopper: git mirror of ${repo}: whether a push holds push requirements: ${why}`); return undefined; };
    let r: GitRemote;
    try { r = await remote(); } catch (e) { return problem(`no credential to fetch with: ${(e as Error).message}`); }
    const env = gitEnv(r);
    const path = mirrorPathOf(o.dir, repo);
    const notReady = await readyMirror(git, path, r.url, env);
    if (notReady) return problem(notReady);
    const run = (args: string[], more: Record<string, string> = {}) => git(['--git-dir', path, ...args], { ...env, ...more });
    // The pack is thin against what GitHub holds: the base branch's tip, in the mirror, gives most of what it is made on.
    const listed = await run(['ls-remote', 'origin', `refs/heads/${push.base}`]);
    const base = listed.stdout.split(/\s/)[0] ?? '';
    if (listed.code === 0 && SHA.test(base) && (await run(['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
      traffic.gitFetch(repo);
      const fetched = await run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', 'origin', base]);
      if (fetched.code !== 0) return problem(said(fetched));
    }
    const quarantine = join(path, `hopper-quarantine-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(quarantine, 'pack'), { recursive: true, mode: 0o700 });
    const q = { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(path, 'objects') };
    try {
      if (push.pack.length > 0) {
        const indexed = await runGitWithInput(['--git-dir', path, 'index-pack', '--stdin', '--fix-thin'], { ...env, ...q }, push.pack);
        if (indexed.code !== 0) return problem(`index-pack: ${said(indexed)}`);
      }
      const tree = await run(['ls-tree', '-r', '--name-only', '-z', push.new], q);
      if (tree.code !== 0) return problem(`ls-tree: ${said(tree)}`);
      return tree.stdout.split('\0').some((f) => f !== '' && requirementsFileDir(f) !== undefined);
    } finally {
      rmSync(quarantine, { recursive: true, force: true });
    }
  };
}
