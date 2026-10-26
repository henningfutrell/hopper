// Pass reads (issue #822, design.md "One read per sync pass"): inside one sync pass of a GitHub source, a read of the
// GitHubApi with the same arguments is asked of GitHub once, and its answer is shared. The check, the reports and the
// follow of each job read the same issues and pull requests; the GraphQL ones are POSTs, which the shared rate limiter's
// ETag cache cannot answer. A write to a repository drops what the open passes read of it, and every read not of one
// repository, so a pass never acts on what it changed itself. A read that failed is not kept. Outside a pass — a
// job's end, reported when it happens — and in the next pass, every read goes to GitHub. Each pass is counted (issue
// #858, `traffic.ts`): what it asked of GitHub, each GraphQL call under the read or write that made it, one line when it ends.
import { AsyncLocalStorage } from 'node:async_hooks';
import { githubTraffic, type GitHubTraffic } from '../../github-limiter/traffic.ts';
import type { GitHubApi } from './api.ts';

const READS = [
  'getIssue', 'subIssues', 'listComments', 'issueEdits', 'linkedItem', 'issuePlace', 'projectItems', 'assignedAt', 'issueEvents',
  'closingPullRequest', 'openClosingPullRequests', 'referencingPullRequests', 'crossReferences', 'pullRequest', 'openPullRequests', 'mergedPullRequestsInto',
  'listAssignedIssues', 'listRepos', 'issuesChangedSince', 'openPullRequestsIn', 'pullRequestStates', 'jobLog', 'taggedItems', 'headChecks', 'checkRuns', 'workflowRun', 'pullRequestReviews',
] as const;
export const WRITES = ['ensureLabel', 'addLabels', 'removeLabels', 'addAssignees', 'reopenIssue', 'closeAsCompleted', 'closeAsNotPlanned', 'postComment', 'fileIssue', 'merge', 'closeWithoutMerge', 'retarget', 'toDraft', 'baseMerge', 'rerunJob'] as const;
/** Reads whose first argument is not a repository: any write drops them. */
const UNSCOPED = new Set<string>(['projectItems', 'taggedItems', 'listAssignedIssues', 'listRepos', 'openPullRequestsIn', 'pullRequestStates']);

// Every method of the port is a read, a write, the bot's login (no GitHub call after the first), where git fetches
// (issue #858: a token, asked once per pass by the mirror), or git's own answer (issues #939, #1076: no GitHub call): a new one
// must be sorted.
type Sorted = (typeof READS)[number] | (typeof WRITES)[number] | 'gitRemote' | 'conflictBetween' | 'baseTip' | 'changedLines';
const _everyMethodSorted: Exclude<keyof GitHubApi, Sorted> extends never ? true : never = true;
void _everyMethodSorted;

interface Kept { repo: string | undefined; answer: Promise<unknown> }
type Pass = Map<string, Kept>;
type Method = (...args: unknown[]) => Promise<unknown>;

export interface PassReads {
  /** The port as the source uses it: its reads shared inside a pass. */
  api: GitHubApi;
  /** Run one sync pass: the reads `run` makes, and the reads of what it starts, are asked once. `idle`: why it takes nothing new. */
  pass<T>(run: () => Promise<T>, idle?: string): Promise<T>;
  /** The REST and GraphQL calls the last pass made (issue #1264); 0 before the first. */
  calls(): number;
}

/** `source`: the source's name, which its pass line names. `traffic`: the process's own unless a test gives one. */
export function passReads(api: GitHubApi, source: string, traffic: GitHubTraffic = githubTraffic): PassReads {
  const current = new AsyncLocalStorage<Pass>();
  const open = new Set<Pass>();
  const port = api as unknown as Record<string, Method | undefined>;
  const out: Record<string, unknown> = {};

  const read = (name: string, fn: Method): Method => (...args) => {
    const pass = current.getStore();
    if (!pass || !open.has(pass)) return traffic.read(name, () => fn(...args));
    const key = `${name} ${JSON.stringify(args)}`;
    const was = pass.get(key);
    if (was) return was.answer;
    const answer = traffic.read(name, () => fn(...args));
    pass.set(key, { repo: UNSCOPED.has(name) ? undefined : String(args[0]), answer });
    answer.catch(() => { if (pass.get(key)?.answer === answer) pass.delete(key); });
    return answer;
  };

  // Dropped when the write starts and again when it ends: a read made while it was under way may hold the old answer.
  const write = (name: string, fn: Method): Method => (...args) => {
    const repo = String(args[0]);
    const drop = () => { for (const pass of open) for (const [key, kept] of pass) if (kept.repo === undefined || kept.repo === repo) pass.delete(key); };
    drop();
    return traffic.read(name, () => fn(...args)).finally(drop);
  };

  for (const name of READS) { const fn = port[name]; if (fn) out[name] = read(name, fn.bind(api)); }
  for (const name of WRITES) { const fn = port[name]; if (fn) out[name] = write(name, fn.bind(api)); }
  if (api.gitRemote) out.gitRemote = api.gitRemote.bind(api);
  if (api.conflictBetween) out.conflictBetween = api.conflictBetween.bind(api);
  if (api.baseTip) out.baseTip = api.baseTip.bind(api);
  if (api.changedLines) out.changedLines = api.changedLines.bind(api);

  let last = 0;
  return {
    api: out as unknown as GitHubApi,
    calls: () => last,
    pass(run, idle) {
      return traffic.pass(source, async () => {
        const pass: Pass = new Map();
        open.add(pass);
        try {
          return await current.run(pass, run);
        } finally {
          open.delete(pass);
        }
      }, (n) => { last = n; }, idle);
    },
  };
}
