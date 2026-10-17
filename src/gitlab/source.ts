// The GitLab source (issue #1448 part 2, design.md "A GitLab source"): the open issues labelled `hopper` in the projects
// picked for the user's GitLab account, read through that account's token, listed in Intake. This part takes no job from
// GitLab: a job cannot act through GitLab yet (its git and its API through the hopper are a later part), so each issue is
// listed with why it is not taken, and nothing is written to GitLab. Paused while no account is attached, its token ended,
// or no project is picked.
import type { JobSource, SourceSignal } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import type { SourceItem } from '../domain/source-item.ts';
import type { IntakeOutcome } from '../domain/intake.ts';
import { GITLAB_LABEL, type GitLabIssue } from '../domain/gitlab-account.ts';
import type { GitLabAccount } from './account.ts';

/** Why a GitLab issue assigned to the account is not taken: this part only lists them. */
export const NOT_TAKEN_YET = 'jobs do not act through GitLab yet: the hopper lists this issue, and takes it in a later version';

export function createGitLabSource(o: { name: string; account: GitLabAccount; label?: string }): JobSource {
  const label = o.label ?? GITLAB_LABEL;
  let listed: GitLabIssue[] = [];
  let repoErrors: Record<string, string> = {};
  const outcome = (i: GitLabIssue, account: string | undefined): IntakeOutcome => {
    const mine = account !== undefined && i.assignees.some((a) => a.toLowerCase() === account.toLowerCase());
    return {
      key: i.url, title: i.title, repo: i.project,
      ...(mine
        ? { reason: NOT_TAKEN_YET, group: 'other' as const }
        : { reason: `not assigned to your GitLab account${account ? ` ${account}` : ''}: assign it at GitLab`, group: 'not-assigned' as const }),
    };
  };
  return {
    name: o.name,
    kind: 'gitlab-account',
    describe() {
      const s = o.account.status();
      const connected = 'account' in s ? { login: s.account, baseUrl: s.baseUrl, projects: s.projects } : {};
      return { ...connected, label, issues: listed.length, ...(Object.keys(repoErrors).length ? { repoErrors } : {}) };
    },
    paused: () => o.account.paused(),
    async discover(): Promise<SourceItem[]> {
      const s = o.account.status();
      if (s.state !== 'connected') { listed = []; repoErrors = {}; return []; }
      const read: GitLabIssue[] = [];
      const errors: Record<string, string> = {};
      for (const project of s.projects) {
        try {
          read.push(...await o.account.issues(project, label));
        } catch (err) {
          errors[project] = (err as Error).message;
          if (o.account.status().state !== 'connected') break; // its token ended: the rest would be refused too
        }
      }
      if (o.account.status().state !== 'connected') { listed = []; repoErrors = {}; return []; } // ended now: paused from the next sync
      listed = read; repoErrors = errors;
      const projects = s.projects.length;
      if (projects > 0 && Object.keys(errors).length === projects) throw new Error(`GitLab answered no project: ${Object.values(errors)[0]}`);
      return [];
    },
    intake() {
      const s = o.account.status();
      const account = 'account' in s ? s.account : undefined;
      return listed.map((i) => outcome(i, account));
    },
    check: async (_active: Job[]): Promise<SourceSignal[]> => [],
    report: async (r) => r.job.sourceState?.source ?? {}, // never asked: this part takes no job
  };
}
