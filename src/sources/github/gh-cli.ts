// GitHubApi over the `gh` CLI (already authenticated on the laptop). execFile, no shell; the
// environment passes through for gh's keyring auth. Comment bodies go on stdin, never argv:
// argv is world-readable in /proc and capped by MAX_ARG_STRLEN.

import { execFile } from 'node:child_process';
import { GitHubApiError, isPermanent } from './api.ts';
import type { GitHubApi, GitHubComment, GitHubIssue, GitHubProjectItem } from './api.ts';

const DEFAULT_TIMEOUT_MS = 30000;
const SEARCH_FIELDS = 'url,number,title,body,author,labels,repository,updatedAt,state';
const LIST_FIELDS = 'url,number,title,body,author,labels,updatedAt,state';
/** Keys of a `gh project item-list` item that are not project fields. */
const ITEM_META_KEYS = new Set(['id', 'content', 'title', 'labels', 'assignees', 'repository', 'milestone', 'linked pull requests']);

interface CliIssue {
  url: string; number: number; title: string; body?: string | null; state?: string; updatedAt: string;
  author?: { login?: string } | null; labels?: { name: string }[]; repository?: { nameWithOwner?: string };
}
interface RestIssue {
  number: number; title: string; body?: string | null; state: string; html_url: string; updated_at: string;
  user?: { login?: string } | null; labels?: ({ name: string } | string)[]; closed_by?: { login?: string } | null;
}
interface RestComment { id: number; body?: string | null; user?: { login?: string } | null; created_at: string; html_url: string }

function errorFrom(stderr: string, fallback: string): GitHubApiError {
  const message = stderr.trim() || fallback;
  const m = /HTTP (\d{3})/.exec(message);
  let status = m ? Number(m[1]) : undefined;
  if (status === undefined && /Could not resolve to/i.test(message)) status = 404;
  return new GitHubApiError(message, isPermanent(status, message), status);
}

function state(s: string | undefined): 'open' | 'closed' {
  return s?.toLowerCase() === 'closed' ? 'closed' : 'open';
}

function fromCli(i: CliIssue, repo: string): GitHubIssue {
  return {
    repo, number: i.number, url: i.url, title: i.title, body: i.body ?? '', author: i.author?.login ?? '',
    labels: (i.labels ?? []).map((l) => l.name), state: state(i.state), updatedAt: i.updatedAt,
  };
}

function fromRest(i: RestIssue, repo: string): GitHubIssue {
  return {
    repo, number: i.number, url: i.html_url, title: i.title, body: i.body ?? '', author: i.user?.login ?? '',
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)), state: state(i.state), updatedAt: i.updated_at,
    ...(i.closed_by?.login ? { closedBy: i.closed_by.login } : {}),
  };
}

function commentFrom(c: RestComment): GitHubComment {
  return { id: c.id, author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at, url: c.html_url };
}

export function createGhCliApi(o: { bin: string; timeoutMs?: number }): GitHubApi {
  const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const exec = (args: string[], stdin?: string): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile(o.bin, args, {
      timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      const what = `gh ${args.slice(0, 2).join(' ')}`;
      if (e.killed) return reject(new GitHubApiError(`${what} timed out after ${timeout} ms`, false));
      if (typeof e.code === 'string') return reject(new GitHubApiError(`${o.bin}: ${e.message}`, false));
      reject(errorFrom(stderr, `${what}: ${e.message}`));
    });
    child.stdin?.on('error', () => { /* reported through the exit callback */ });
    child.stdin?.end(stdin ?? '');
  });

  const json = async <T>(args: string[], stdin?: string): Promise<T> => {
    const out = await exec(args, stdin);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new GitHubApiError(`gh ${args.slice(0, 2).join(' ')}: output is not JSON: ${out.slice(0, 200)}`, false);
    }
  };

  return {
    async whoami() {
      return (await exec(['api', 'user', '--jq', '.login'])).trim();
    },
    async searchOpenIssues({ owners, label }) {
      const args = ['search', 'issues', ...owners.flatMap((w) => ['--owner', w]), '--label', label, '--state', 'open', '--json', SEARCH_FIELDS, '--limit', '200'];
      return (await json<CliIssue[]>(args)).map((i) => fromCli(i, i.repository?.nameWithOwner ?? ''));
    },
    async listOpenIssues(repo, label) {
      const args = ['issue', 'list', '-R', repo, '--label', label, '--state', 'open', '--json', LIST_FIELDS, '--limit', '200'];
      return (await json<CliIssue[]>(args)).map((i) => fromCli(i, repo));
    },
    async getIssue(repo, number) {
      return fromRest(await json<RestIssue>(['api', `repos/${repo}/issues/${number}`]), repo);
    },
    async listComments(repo, number) {
      const pages = await json<RestComment[][]>(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments?per_page=100`]);
      return pages.flat().map(commentFrom);
    },
    async projectItems(owner, number) {
      const r = await json<{ items?: (Record<string, unknown> & { content?: { url?: string } })[] }>([
        'project', 'item-list', String(number), '--owner', owner, '--format', 'json', '--limit', '1000', '--query', 'is:issue is:open',
      ]);
      const items: GitHubProjectItem[] = [];
      (r.items ?? []).forEach((item, index) => {
        const url = item.content?.url;
        if (!url) return;
        const fields: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(item)) {
          if (!ITEM_META_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) fields[k] = v;
        }
        items.push({ url, index, fields });
      });
      return items;
    },
    async ensureLabel(repo, name, color, description) {
      await exec(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
    },
    async addLabels(repo, number, labels) {
      await exec(['issue', 'edit', String(number), '-R', repo, '--add-label', labels.join(',')]);
    },
    async removeLabels(repo, number, labels) {
      await exec(['issue', 'edit', String(number), '-R', repo, '--remove-label', labels.join(',')]);
    },
    async comment(repo, number, body) {
      const c = await json<RestComment>(['api', `repos/${repo}/issues/${number}/comments`, '-X', 'POST', '--input', '-'], JSON.stringify({ body }));
      return { id: c.id, url: c.html_url, createdAt: c.created_at };
    },
  };
}
