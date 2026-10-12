// Pass reads (issue #822, design.md "One read per sync pass"): inside one sync pass of a GitHub source, a read of the
// GitHubApi with the same arguments is asked of GitHub once, and its answer is shared. The check, the reports and the
// follow of each job read the same issues and pull requests; the GraphQL ones are POSTs, which the shared rate limiter's
// ETag cache cannot answer. A write to a repository drops what the open passes read of it, and every read not of one
// repository, so a pass never acts on what it changed itself. A read that failed is not kept. Outside a pass — a
// job's end, reported when it happens — and in the next pass, every read goes to GitHub.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GitHubApi } from './api.ts';

const READS = [
  'listOpenIssues', 'getIssue', 'subIssues', 'listComments', 'issueEdits', 'issuePlace', 'projectItems', 'assignedAt', 'issueEvents',
  'closingPullRequest', 'openClosingPullRequests', 'referencingPullRequests', 'crossReferences', 'pullRequest', 'openPullRequests',
  'listAssignedIssues', 'listInstalledRepos',
] as const;
const WRITES = ['ensureLabel', 'addLabels', 'removeLabels', 'addAssignees', 'reopenIssue', 'closeAsCompleted', 'postComment', 'merge', 'closeWithoutMerge', 'toDraft'] as const;
/** Reads whose first argument is not a repository: any write drops them. */
const UNSCOPED = new Set<string>(['projectItems', 'listAssignedIssues', 'listInstalledRepos']);

// Every method of the port is a read, a write, or the bot's login (no GitHub call after the first): a new one must be sorted.
type Sorted = (typeof READS)[number] | (typeof WRITES)[number] | 'botLogin';
const _everyMethodSorted: Exclude<keyof GitHubApi, Sorted> extends never ? true : never = true;
void _everyMethodSorted;

interface Kept { repo: string | undefined; answer: Promise<unknown> }
type Pass = Map<string, Kept>;
type Method = (...args: unknown[]) => Promise<unknown>;

export interface PassReads {
  /** The port as the source uses it: its reads shared inside a pass. */
  api: GitHubApi;
  /** Run one sync pass: the reads `run` makes, and the reads of what it starts, are asked once. */
  pass<T>(run: () => Promise<T>): Promise<T>;
}

export function passReads(api: GitHubApi): PassReads {
  const current = new AsyncLocalStorage<Pass>();
  const open = new Set<Pass>();
  const port = api as unknown as Record<string, Method | undefined>;
  const out: Record<string, unknown> = {};

  const read = (name: string, fn: Method): Method => (...args) => {
    const pass = current.getStore();
    if (!pass || !open.has(pass)) return fn(...args);
    const key = `${name} ${JSON.stringify(args)}`;
    const was = pass.get(key);
    if (was) return was.answer;
    const answer = fn(...args);
    pass.set(key, { repo: UNSCOPED.has(name) ? undefined : String(args[0]), answer });
    answer.catch(() => { if (pass.get(key)?.answer === answer) pass.delete(key); });
    return answer;
  };

  // Dropped when the write starts and again when it ends: a read made while it was under way may hold the old answer.
  const write = (fn: Method): Method => (...args) => {
    const repo = String(args[0]);
    const drop = () => { for (const pass of open) for (const [key, kept] of pass) if (kept.repo === undefined || kept.repo === repo) pass.delete(key); };
    drop();
    return fn(...args).finally(drop);
  };

  for (const name of READS) { const fn = port[name]; if (fn) out[name] = read(name, fn.bind(api)); }
  for (const name of WRITES) { const fn = port[name]; if (fn) out[name] = write(fn.bind(api)); }
  if (api.botLogin) out.botLogin = api.botLogin.bind(api);

  return {
    api: out as unknown as GitHubApi,
    async pass(run) {
      const pass: Pass = new Map();
      open.add(pass);
      try {
        return await current.run(pass, run);
      } finally {
        open.delete(pass);
      }
    },
  };
}
