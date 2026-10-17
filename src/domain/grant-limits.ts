// Grant limits (issue #892, design.md "Grant limits"): beside its scopes, a grant may name the repositories (`owner/name`)
// and the job sources its tokens act on. The scopes say which routes; the limits say on what. A limited grant's act names
// its **targets** — the repository and the job source of the job, question, pull request or item it acts on — and each
// target must be in every list the grant names. An act that names no target, or a target with no repository (no job
// source) while the grant names repositories (job sources), is refused: deny by default, as for scopes. Pure.

/** What a grant is limited to. A list absent or empty: no limit of that kind. */
export interface GrantLimits { repos?: string[]; sources?: string[] }

/** What an act acts on: a repository (`owner/name`) and a job source (its name), as far as the act names them. */
export interface LimitTarget { repo?: string; source?: string }

/** At most this many repositories, and as many job sources, per grant. */
export const GRANT_LIMITS_MAX = 50;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE = /^[A-Za-z0-9_.:-]{1,64}$/;
const GITHUB_ITEM = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/\d+$/;

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Why the limits are malformed, or undefined. */
export function limitsProblem(l: GrantLimits): string | undefined {
  for (const [kind, list] of [['repositories', l.repos], ['job sources', l.sources]] as const) {
    if (list !== undefined && list.length > GRANT_LIMITS_MAX) return `a grant names at most ${GRANT_LIMITS_MAX} ${kind}`;
  }
  const repo = l.repos?.find((r) => !REPO.test(r));
  if (repo !== undefined) return `limits: ${JSON.stringify(repo)} is no repository: name it owner/name`;
  const source = l.sources?.find((s) => !SOURCE.test(s));
  if (source !== undefined) return `limits: ${JSON.stringify(source)} is no job source name: letters, digits, . _ : -, at most 64`;
  return undefined;
}

/** The limits in their one form: repositories lower case, each list sorted and once. Undefined: they limit nothing. */
export function normalLimits(l: GrantLimits): GrantLimits | undefined {
  const repos = [...new Set((l.repos ?? []).map((r) => r.toLowerCase()))].sort();
  const sources = [...new Set(l.sources ?? [])].sort();
  if (repos.length === 0 && sources.length === 0) return undefined;
  return { ...(repos.length ? { repos } : {}), ...(sources.length ? { sources } : {}) };
}

/** Why a grant with these limits may not do an act on `targets`, or undefined: it may. */
export function limitRefusal(l: GrantLimits, targets: readonly LimitTarget[]): string | undefined {
  const repos = l.repos?.length ? l.repos : undefined;
  const sources = l.sources?.length ? l.sources : undefined;
  if (!repos && !sources) return undefined;
  const to = [repos && `the repositories ${repos.join(', ')}`, sources && `the job sources ${sources.join(', ')}`].filter(Boolean).join(' and ');
  if (targets.length === 0) return `its grant is limited to ${to}, and this act names no repository or job source to check`;
  for (const t of targets) {
    if (repos) {
      if (t.repo === undefined) return `its grant is limited to ${to}, and this acts on no repository`;
      if (!repos.some((r) => sameRepo(r, t.repo!))) return `its grant is limited to ${to}, and this acts on ${t.repo.toLowerCase()}`;
    }
    if (sources) {
      if (t.source === undefined) return `its grant is limited to ${to}, and this acts on no job source`;
      if (!sources.includes(t.source)) return `its grant is limited to ${to}, and this acts on the job source ${t.source}`;
    }
  }
  return undefined;
}

/** The repository an item key names (lower case), when it is a GitHub issue or pull request URL; else undefined. */
export function repoOfItemKey(key: string): string | undefined {
  return GITHUB_ITEM.exec(key)?.[1]?.toLowerCase();
}
