// The fake GitHub's branch heads (issue #870), for test/support/fake-forges.ts: what the vault's apply gate reads to
// know a plan was made at the commit its branch is at now. `GET /repos/{owner}/{repo}/commits/{ref}` answers `{ sha }`.
// Branches made and files put on them (issue #946) are fake-contents.ts, exported from here beside the heads.

export { contentsRoute, type ContentsForge } from './fake-contents.ts';

/** The fake GitHub's option for it (a field of `FakeForge`). */
export interface HeadsForge {
  /** GitHub: each branch's head commit, by `owner/name@ref`; a branch not named here is 404. */
  heads?: Record<string, string>;
}

/** The answer to a GET of a ref's commit in `repo`; undefined: `rest` is none. */
export function headsRoute(forge: HeadsForge | undefined, method: string, repo: string, rest: string): { status: number; body: unknown } | undefined {
  const m = /^commits\/([^/]+)$/.exec(rest);
  if (method !== 'GET' || !m) return undefined;
  const sha = forge?.heads?.[`${repo}@${decodeURIComponent(m[1]!)}`];
  return sha ? { status: 200, body: { sha } } : { status: 404, body: { message: 'No commit found for SHA' } };
}
