// Filing an issue that the hopper assigns (issue #1856). GitHub drops an assignee it cannot set from a new issue with no
// error, and keeps its labels: an issue with the job sources' label and no assignee sits in Intake as not assigned to the
// user, and never becomes a job. So the answer's assignees are read, each one it dropped is added again in its own call,
// and an assignee GitHub still drops is told to the caller, never hidden.
import { splitRepo, type Request } from './http.ts';

/** What GitHub answers for an issue, the fields read here. */
interface Filed { id?: number; number: number; html_url: string; assignees?: ({ login?: string } | null)[] | null }

export interface IssueToFile { title: string; body: string; labels?: string[]; assignees?: string[] }

/** The filed issue; `unassigned`: the assignees GitHub did not set, after the second try (absent: all are set). */
export interface FiledIssue { id?: number; number: number; url: string; unassigned?: string[] }

const missing = (wanted: string[], d: Filed): string[] => {
  const set = new Set((d.assignees ?? []).map((a) => a?.login?.toLowerCase()).filter(Boolean));
  return wanted.filter((w) => !set.has(w.toLowerCase()));
};

export async function fileAssignedIssue(req: Request, headers: Record<string, string>, repo: string, issue: IssueToFile): Promise<FiledIssue> {
  const at = splitRepo(repo);
  const d = (await req('POST /repos/{owner}/{repo}/issues', { ...at, ...issue, headers })).data as Filed;
  const filed = { ...(d.id !== undefined ? { id: d.id } : {}), number: d.number, url: d.html_url };
  const dropped = missing(issue.assignees ?? [], d);
  if (dropped.length === 0) return filed;
  let left = dropped;
  try {
    const a = (await req('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', { ...at, issue_number: d.number, assignees: dropped, headers })).data as Filed;
    left = missing(dropped, a);
  } catch {
    // The issue is filed: a failed assign is told as unassigned, never as a failed filing (that would file it twice).
  }
  return left.length === 0 ? filed : { ...filed, unassigned: left };
}
