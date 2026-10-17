// gitlab-account: GitLab issues labelled hopper in the projects picked for the GitLab account the user attached (issue #1448
// part 2, design.md "A GitLab source"), read through that account's personal access token, listed in Intake. Paused until the
// user connects GitLab (Sources → GitLab) and picks projects; nothing to set up here. The hopper adds its instance,
// `gitlab-account`, while a GitLab account is attached: never the plugins config.
import { createGitLabSource } from '../../../gitlab/source.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface GitLabAccountOptions { enabled: boolean; pollSeconds: number; label: string }

export function gitlabAccountPlugin(): PluginDefinition<'job-source', GitLabAccountOptions> {
  return {
    id: 'gitlab-account',
    role: 'job-source',
    describe: 'GitLab issues labelled hopper, through the GitLab account you connect (Sources → GitLab)',
    options: (z) => z.object({
      enabled: z.boolean().default(true),
      pollSeconds: z.number().int().min(30).max(3600).default(120),
      label: z.string().min(1).max(100).default('hopper'),
    }).strict(),
    sameWork: (a, b) => a.enabled && b.enabled && a.label === b.label,
    detect: async () => ({ status: 'available', detail: 'the GitLab account connected in Sources' }),
    create(ctx, o) {
      if (!o.enabled || !ctx.gitlabAccount) return { disabled: { kind: 'gitlab-account', detail: {} } };
      return { source: createGitLabSource({ name: ctx.instanceName, account: ctx.gitlabAccount, label: o.label }), pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default gitlabAccountPlugin();
