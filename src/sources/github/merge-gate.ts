// The merge gate (issue #939, design.md "The tending queue"): the hopper's own merges (yolo mode) of one repository in one
// sync pass go one at a time, and a pull request that conflicts with one merged before it in the pass is not merged. Its
// merge would be refused, or, once GitHub saw the new base, it would have merge conflicts: the next sync sees them and
// tends it against the new base. Whether two conflict is git's (`GitHubApi.conflictBetween`, the hopper's mirror); where
// git cannot say, the merge is made, as before. Outside a sync pass each merge is made.
import { githubTraffic } from '../../github-limiter/traffic.ts';
import type { GitHubApi } from './api.ts';

export interface MergeGate {
  /**
   * Make the merge of pull request `url` of `repo` into `base` (`merge`), unless it conflicts with one merged before it in
   * this pass: then that one's URL, and no merge. A throw of `merge` is thrown.
   */
  merge(repo: string, base: string | undefined, url: string, merge: () => Promise<void>): Promise<string | undefined>;
}

interface Merged { pass: number; urls: string[]; chain: Promise<unknown> }

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/** The gate over `api`'s git answers; `passId` the sync pass this runs in (undefined outside any), the process's by default. */
export function createMergeGate(api: Pick<GitHubApi, 'conflictBetween'>, passId: () => number | undefined = () => githubTraffic.passId()): MergeGate {
  const repos = new Map<string, Merged>();

  async function heldBehind(repo: string, base: string | undefined, url: string, before: readonly string[]): Promise<string | undefined> {
    if (!api.conflictBetween || base === undefined) return undefined;
    for (const m of before) if (await api.conflictBetween(repo, base, numberOf(url), numberOf(m)) === true) return m;
    return undefined;
  }

  return {
    merge(repo, base, url, merge) {
      const pass = passId();
      if (pass === undefined) return merge().then(() => undefined);
      const key = repo.toLowerCase();
      let at = repos.get(key);
      if (at?.pass !== pass) {
        at = { pass, urls: [], chain: Promise.resolve() };
        repos.set(key, at);
      }
      const here = at;
      const run = here.chain.then(async () => {
        const held = await heldBehind(repo, base, url, here.urls);
        if (held) return held;
        await merge();
        here.urls.push(url);
        return undefined;
      });
      here.chain = run.catch(() => undefined);
      return run;
    },
  };
}

const gates = new WeakMap<object, MergeGate>();

/** The one gate of `api` (a source's own port), made the first time. */
export function mergeGateOf(api: Pick<GitHubApi, 'conflictBetween'>): MergeGate {
  return gates.get(api) ?? gates.set(api, createMergeGate(api)).get(api)!;
}
