// What GitHub shows of a repository's setup (issue #652 requirement 8, design.md "Repository setup"), read with the
// person's own GitHub connection: for each guarded branch — the default branch and each release branch the repository
// has (`RELEASE_BRANCHES`, the branches no job pushes to) — the branch (`protected`, its required checks), its rulesets'
// rules, and its branch protection; and the repository's secret scanning and push protection
// (`security_and_analysis`). GitHub shows the branch protection and the security settings only to a repository admin:
// a 403 or 404 there, or a missing field, is unread, never "off".
import { RELEASE_BRANCHES } from '../github-proxy/index.ts';
import { branchSetup, type BranchProtectionRead, type RepoSetupFound } from '../domain/types.ts';
import { splitRepo, statusOf, type Request } from '../sources/github/app/http.ts';

interface Rule { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }
interface Protection { required_pull_request_reviews?: unknown; allow_force_pushes?: { enabled?: boolean }; required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } }
interface Branch { protected?: boolean; protection?: { required_status_checks?: { contexts?: string[] } } }
/** The part of `GET /repos/{r}` the setup reads; `security_and_analysis` only for an admin. */
export interface RepoAnswer {
  default_branch: string;
  security_and_analysis?: { secret_scanning?: { status?: string }; secret_scanning_push_protection?: { status?: string } } | null;
}

/** The default branch first, then each release branch that is not it. */
export const guardedBranches = (defaultBranch: string): string[] =>
  [defaultBranch, ...RELEASE_BRANCHES.filter((b) => b !== defaultBranch.toLowerCase())];

const enabled = (s: { status?: string } | undefined): boolean | null => (s?.status === undefined ? null : s.status === 'enabled');

export function createSetupReader(req: Request) {
  /** `p`, or `none` on the status GitHub answers when there is none. */
  const orNone = async <T, N>(p: Promise<T>, none: N, statuses: number[] = [404]): Promise<T | N> => {
    try {
      return await p;
    } catch (err) {
      if (statuses.includes(statusOf(err) ?? 0)) return none;
      throw err;
    }
  };

  /** One branch as GitHub shows it; undefined when the repository has no such branch. A missing default branch throws. */
  async function branch(token: string, repo: string, name: string, isDefault: boolean): Promise<BranchProtectionRead | undefined> {
    const at = { ...splitRepo(repo), branch: name, headers: { authorization: `token ${token}` } };
    const asked = req('GET /repos/{owner}/{repo}/branches/{branch}', at).then((r) => r.data as Branch);
    const b = isDefault ? await asked : await orNone(asked, undefined);
    if (!b) return undefined;
    const rules = await orNone(req('GET /repos/{owner}/{repo}/rules/branches/{branch}', at).then((r) => r.data as Rule[]), []);
    const p = b.protected === true
      ? await orNone(req('GET /repos/{owner}/{repo}/branches/{branch}/protection', at).then((r) => r.data as Protection), undefined, [403, 404])
      : undefined;
    const checks = [
      ...(b.protection?.required_status_checks?.contexts ?? []),
      ...rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context ?? ''),
      ...(p?.required_status_checks?.contexts ?? []),
      ...(p?.required_status_checks?.checks ?? []).map((c) => c.context ?? ''),
    ];
    return {
      branch: name,
      protected: b.protected === true,
      checks: [...new Set(checks.filter((c) => c !== ''))],
      rules: [...new Set(rules.map((r) => r.type ?? '').filter((t) => t !== ''))],
      ...(b.protected !== true ? { protection: 'none' as const } : p ? { protection: { pullRequest: p.required_pull_request_reviews != null, forcePushes: p.allow_force_pushes?.enabled === true } } : {}),
    };
  }

  return {
    /** The guarded branches as read (the default branch first) and the repository's setup. */
    async read(token: string, repo: string, answer: RepoAnswer): Promise<{ branches: BranchProtectionRead[]; setup: RepoSetupFound }> {
      const read = await Promise.all(guardedBranches(answer.default_branch).map((b, i) => branch(token, repo, b, i === 0)));
      const branches = read.filter((b): b is BranchProtectionRead => b !== undefined);
      const security = answer.security_and_analysis ?? undefined;
      return {
        branches,
        setup: { branches: branches.map(branchSetup), secretScanning: enabled(security?.secret_scanning), pushProtection: enabled(security?.secret_scanning_push_protection) },
      };
    },
  };
}
