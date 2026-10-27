// The job egress allowlist as the UI shows it (issue #2849 part 3): the hosts the jobs asked for, one Needs you line each, and
// the allowlist's text fields in Settings → Job egress — a host a line, and a repository's hosts as `owner/name host:port …`.
import type { JobEgressAsk, JobEgressSettings } from '../../../src/domain/job-egress.ts';

/** `GET /api/job-egress`. */
export interface JobEgressView {
  egress: JobEgressSettings;
  defaultHosts: readonly string[];
  asks: readonly JobEgressAsk[];
}

/** Whether `v` is the answer of `GET /api/job-egress`: a fake answers `{}` for a route it does not know. */
export const isJobEgressView = (v: unknown): v is JobEgressView =>
  typeof v === 'object' && v !== null && Array.isArray((v as JobEgressView).asks) && typeof (v as JobEgressView).egress?.repos === 'object';

/** One line per host the jobs asked for: the host, whose jobs, and how many. */
export function egressAskLines(view: JobEgressView | undefined): string[] {
  return (view?.asks ?? []).map((a) => `${a.host}: refused to ${a.jobIds.length === 1 ? '1 job' : `${a.jobIds.length} jobs`} of ${a.repo ?? 'no repository'} — approve or dismiss it in Settings → Job egress`);
}

/** The entries of a text field, a host a line or split by spaces or commas. */
export const hostsOf = (text: string): string[] => text.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);

/** The repositories' hosts as text: `owner/name host:port host:port`, a repository a line. */
export const reposText = (repos: Readonly<Record<string, readonly string[]>>): string =>
  Object.entries(repos).map(([r, hosts]) => `${r} ${hosts.join(' ')}`).join('\n');

/** The repositories' hosts from text; a line with a repository and no host is dropped. */
export function reposOf(text: string): Record<string, string[]> {
  const repos: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const [repo, ...hosts] = hostsOf(line);
    if (repo && hosts.length) repos[repo] = [...(repos[repo] ?? []), ...hosts];
  }
  return repos;
}
