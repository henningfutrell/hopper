// What the pending approvals read of GitHub (issue #2088, design.md "Pending approvals"), with the person's own GitHub
// connection: the repositories the app's installations on the intake orgs reach (`GET /user/installations`, then each
// one's `…/repositories`, every page; issue #2258), those not archived — an org the app is not installed on is never read —,
// each one's waiting runs
// (`GET …/actions/runs?status=waiting`), and each waiting run's pending deployments (`GET …/runs/{id}/pending_deployments`),
// which say whether the connection can approve each environment. The GitHub App's Actions (read) permission covers both.
// A personal access token (issue #1380) goes through no app: GitHub refuses it the installations (403), and the
// repositories it reaches (`GET /user/repos`) are read in their place.
// Every GET is conditional (conditional.ts): an answer GitHub says is unchanged is a 304, which costs no call. A
// repository GitHub refuses is a problem with its reason; the others are read. A refused token (401) is renewed once.
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/http/http.ts';
import { intakeOrgs, pendingApprovalOf, type PendingApproval, type PendingApprovalsProblem } from '../domain/types.ts';
import type { ConditionalAnswers, Get } from '../repo-checks/conditional.ts';

export interface ApprovalsGitHub {
  /** The waiting runs the connection can approve, in the repositories of `orgs` it reaches; each GET through `answers`. */
  waiting(orgs: readonly string[], answers: ConditionalAnswers): Promise<{ approvals: Omit<PendingApproval, 'stale'>[]; problems: PendingApprovalsProblem[] }>;
}

/** GitHub's page size, the most it gives. */
const PER_PAGE = 100;
/** At most this many pages of repositories: 10,000. */
const MAX_PAGES = 100;
/** The repositories read at once; the shared rate limiter paces them too. */
const AT_ONCE = 6;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? v as Raw : {});

/** GitHub's failure in words, with its status. */
const why = (err: unknown, what: string): string => {
  const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
  const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
  return `GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`;
};

/** GitHub's failure of a whole read, with its status. */
class ApprovalsGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApprovalsGitHubError';
    if (status !== undefined) this.status = status;
  }
}

export function createApprovalsGitHub(o: { apiUrl: string } & TokenSource): ApprovalsGitHub {
  const get = makeRequest(o.apiUrl) as unknown as Get;
  const withToken = tokenCaller(o);
  return {
    waiting(orgs, answers) {
      const wanted = new Set(intakeOrgs(orgs));
      if (wanted.size === 0) return Promise.resolve({ approvals: [], problems: [] });
      return withToken(async (token) => {
        const headers = { authorization: `token ${token}` };
        /** Every page of a list, `pick` reads one page's items. */
        const all = async (route: string, params: Raw, pick: (d: unknown) => unknown): Promise<Raw[]> => {
          const out: Raw[] = [];
          for (let page = 1; page <= MAX_PAGES; page++) {
            const got = pick(await answers.get<unknown>(get, route, { ...params, per_page: PER_PAGE, page, headers }));
            const items = Array.isArray(got) ? got.map(obj) : [];
            out.push(...items);
            if (items.length < PER_PAGE) break;
          }
          return out;
        };
        const ofIntake = (list: Raw[]): string[] => list.flatMap((r) => {
          const name = typeof r.full_name === 'string' ? r.full_name : '';
          return name && r.archived !== true && wanted.has(name.split('/')[0]!.toLowerCase()) ? [name] : [];
        });
        let installs: Raw[] | undefined;
        try {
          installs = await all('GET /user/installations', {}, (d) => obj(d).installations);
        } catch (err) {
          if (statusOf(err) !== 403) throw err; // a token no app holds: the repositories it reaches
        }
        const repos: string[] = [];
        if (installs === undefined) repos.push(...ofIntake(await all('GET /user/repos', {}, (d) => d)));
        else {
          for (const i of installs) {
            const login = obj(i.account).login;
            if (typeof login !== 'string' || !wanted.has(login.toLowerCase())) continue;
            repos.push(...ofIntake(await all('GET /user/installations/{installation_id}/repositories', { installation_id: i.id }, (d) => obj(d).repositories)));
          }
        }
        const approvals: Omit<PendingApproval, 'stale'>[] = [];
        const problems: PendingApprovalsProblem[] = [];
        const one = async (repo: string): Promise<void> => {
          const at = { ...splitRepo(repo), headers };
          try {
            const runs = obj(await answers.get(get, 'GET /repos/{owner}/{repo}/actions/runs', { ...at, status: 'waiting', per_page: PER_PAGE })).workflow_runs;
            for (const run of (Array.isArray(runs) ? runs : []).map(obj)) {
              const deployments = await answers.get<unknown[]>(get, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments', { ...at, run_id: run.id });
              const row = pendingApprovalOf(repo, run, Array.isArray(deployments) ? deployments : []);
              if (row) approvals.push(row);
            }
          } catch (err) {
            // A refused token is the whole read's: it is renewed and the read made again.
            if (statusOf(err) === 401) throw err;
            problems.push({ where: repo, error: why(err, repo) });
          }
        };
        const queue = [...repos];
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => { for (let r = queue.shift(); r !== undefined; r = queue.shift()) await one(r); }));
        return { approvals, problems: problems.sort((a, b) => a.where.localeCompare(b.where)) };
      }, (err) => new ApprovalsGitHubError(why(err, 'the repositories of the intake orgs'), statusOf(err)));
    },
  };
}
