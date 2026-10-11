// The fake GitHub's repositories and forks (issue #429: the contribution flow), for test/support/fake-forges.ts: a
// repository as GitHub's REST answers it to the token's user — whether that user may push to it, whether its issues are
// on, whether it is a fork and of what —, a fork made (`POST …/forks`: `<login>/<name>`, its git a copy of the parent's
// bare repository, its issues off as on GitHub), and its issues turned on (`PATCH` with `has_issues`). An issue filed in
// a repository with issues off is refused (410), as on GitHub.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The fake GitHub's options for it (fields of `FakeForge`). */
export interface ForksForge {
  /** GitHub: repositories the token's user cannot push to (`permissions.push` false): ones they do not own. */
  notPushable?: string[];
  /** GitHub: repositories with issues turned off (`has_issues` false). */
  issuesOff?: string[];
  /** GitHub: the forks, by fork → its parent (owner/name); a fork made through the API is added. */
  forks?: Record<string, string>;
}

type Answer = { status: number; body?: unknown };

/** The answer to a repository or fork request of `repo` by `login`; undefined: `rest` is neither. */
export function forksRoute(
  forge: ForksForge | undefined, gitRoot: string | undefined, base: string, login: string,
  method: string, repo: string, rest: string, body: Record<string, unknown>,
): Answer | undefined {
  const f: ForksForge = forge ?? {};
  const forks = (f.forks ??= {});
  const restRepo = (name: string) => {
    const parent = forks[name];
    const push = !(f.notPushable ?? []).includes(name) && (parent === undefined || name.split('/')[0] === login);
    return {
      full_name: name, html_url: `${base}/${name}`, owner: { login: name.split('/')[0] }, default_branch: 'dev',
      has_issues: !(f.issuesOff ?? []).includes(name), permissions: { admin: push, push, pull: true },
      fork: parent !== undefined, ...(parent ? { parent: { full_name: parent }, source: { full_name: parent } } : {}),
    };
  };
  if (method === 'GET' && rest === '') return { status: 200, body: restRepo(repo) };
  if (method === 'PATCH' && rest === '') {
    if (typeof body.has_issues === 'boolean') {
      f.issuesOff = (f.issuesOff ?? []).filter((r) => r !== repo).concat(body.has_issues ? [] : [repo]);
    }
    return { status: 200, body: restRepo(repo) };
  }
  if (method === 'POST' && rest === 'forks') {
    const name = `${login}/${repo.split('/')[1]}`;
    if (forks[name] === undefined) {
      forks[name] = repo;
      f.issuesOff = [...(f.issuesOff ?? []), name];
      const from = gitRoot && join(gitRoot, `${repo}.git`);
      if (from && existsSync(from)) execFileSync('git', ['clone', '--quiet', '--bare', from, join(gitRoot, `${name}.git`)], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' } });
    }
    return { status: 202, body: restRepo(name) };
  }
  if (method === 'POST' && rest === 'issues' && (f.issuesOff ?? []).includes(repo)) return { status: 410, body: { message: 'Issues are disabled for this repo' } };
  return undefined;
}
