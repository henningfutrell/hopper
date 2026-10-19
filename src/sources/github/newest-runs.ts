// The newest run of each check on a commit (issue #2129). A check that runs again on the same head commit — a re-run, or
// a new event such as an edit of the pull request's body, which starts a new workflow run — supersedes its older runs:
// GitHub's required checks read only the newest run of each check name. Every read of a head commit's checks counts the
// newest runs only, so a check that failed and then passed on the same head is passing.

/**
 * `runs` without the runs a newer run of the same check superseded, in their own order. Newest: the greater id; when one
 * of the two has no id, the later in `runs`. A run with no name is kept.
 */
export function newestRuns<T>(runs: readonly T[], nameOf: (r: T) => string | undefined, idOf: (r: T) => number | undefined): T[] {
  const newest = new Map<string, T>();
  for (const r of runs) {
    const name = nameOf(r);
    if (name === undefined) continue;
    const had = newest.get(name);
    const [a, b] = [had === undefined ? undefined : idOf(had), idOf(r)];
    if (had === undefined || a === undefined || b === undefined || b >= a) newest.set(name, r);
  }
  return runs.filter((r) => {
    const name = nameOf(r);
    return name === undefined || newest.get(name) === r;
  });
}
