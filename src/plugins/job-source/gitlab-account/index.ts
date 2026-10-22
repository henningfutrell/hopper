// gitlab-account: GitLab issues labelled hopper in the projects picked for the GitLab account the user attached (issue #1448
// part 2, design.md "A GitLab source"), read through that account's personal access token, listed in Intake; one assigned to
// the account and of a trusted origin is a job (part 3, "Jobs through GitLab"); its merge request is followed, and merged in
// yolo mode (issue #1642), and a job's done criteria checked on it (issue #1924 part 4); one of another origin is a request card a person approves (issue #1642). Paused until the user connects GitLab
// (Sources → GitLab) and picks projects; nothing to set up here. The hopper adds its instance,
// `gitlab-account`, while a GitLab account is attached: never the plugins config.
import { createGitLabSource } from '../../../gitlab/source.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface GitLabAccountOptions {
  enabled: boolean; pollSeconds: number; label: string;
  priorityLabels: Record<string, number>; defaultPriority: number; executor: string; model: string | null;
}

export function gitlabAccountPlugin(): PluginDefinition<'job-source', GitLabAccountOptions> {
  return {
    id: 'gitlab-account',
    role: 'job-source',
    describe: 'GitLab issues labelled hopper, through the GitLab account you connect (Sources → GitLab)',
    options: (z) => z.object({
      enabled: z.boolean().default(true),
      pollSeconds: z.number().int().min(30).max(3600).default(120),
      label: z.string().min(1).max(100).default('hopper'),
      priorityLabels: z.record(z.string(), z.number()).default({ 'hopper:high': 75, 'hopper:low': 25 }),
      defaultPriority: z.number().min(0).max(100).default(50),
      executor: z.string().min(1).default('herdr-claude'),
      model: z.string().min(1).nullable().default(null),
    }).strict(),
    sameWork: (a, b) => a.enabled && b.enabled && a.label === b.label,
    detect: async () => ({ status: 'available', detail: 'the GitLab account connected in Sources' }),
    create(ctx, o) {
      if (!o.enabled || !ctx.gitlabAccount) return { disabled: { kind: 'gitlab-account', detail: {} } };
      const intake = ctx.intake(ctx.instanceName);
      const source = createGitLabSource({
        name: ctx.instanceName, account: ctx.gitlabAccount, label: o.label, priorityLabels: o.priorityLabels, defaultPriority: o.defaultPriority,
        executor: o.executor, ...(o.model ? { model: o.model } : {}), yoloMode: (project) => ctx.yoloMode(project),
        trust: ctx.intakeTrust, ...(intake ? { intake } : {}),
        ...(ctx.jobDoneCriteria ? { doneCriteria: (jobId: string) => ctx.jobDoneCriteria!(jobId) } : {}),
        ...(ctx.jobAllowedDeletes ? { allowedDeletes: (jobId: string) => ctx.jobAllowedDeletes!(jobId) } : {}),
        ...(ctx.githubOutbox ? { outbox: ctx.githubOutbox } : {}),
      });
      return { source, pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default gitlabAccountPlugin();
