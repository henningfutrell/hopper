// github-account: issues labelled hopper in the GitHub account the user connected (issue #214,
// design.md "Connected accounts") — read and labelled through that account's token, which the
// hopper's GitHub App was granted when the user approved its device code — signing in with GitHub, or
// connecting it from Sources. Paused until the user
// connects GitHub (Sources → Connect GitHub); nothing to set up here. Its instance is named
// `github-account`: jobs and sync state are keyed by it. A further connected account (issue #1448) gets an instance of its
// own, `github-account-2`, …, with `account` set to its key: the hopper adds it, never the plugins config.
import type { GitHubApi } from '../../../sources/index.ts';
import { createAccountSource, githubAccountOptions, sameAccountWork, type GitHubAccountOptions } from '../../../sources/index.ts';
import type { PluginDefinition } from '../../sdk.ts';
import type { ConnectedAccountKey } from '../../../domain/types.ts';

/** The plugin. `seam` (tests) replaces the account adapter. */
export function githubAccountPlugin(seam?: GitHubApi): PluginDefinition<'job-source', GitHubAccountOptions> {
  return {
    id: 'github-account',
    role: 'job-source',
    describe: 'GitHub issues labelled hopper, through the GitHub account you connect (Sources → Connect GitHub)',
    options: () => githubAccountOptions,
    // One source per account and label (issue #1264): a second polls GitHub again for the same issues.
    sameWork: sameAccountWork,
    detect: async () => ({ status: 'available', detail: 'the GitHub account connected in Sources' }),
    create(ctx, o) {
      if (!o.enabled) return { disabled: { kind: 'github-account', detail: {} } };
      const source = createAccountSource({
        name: ctx.instanceName, clock: ctx.clock, knownKeys: ctx.knownKeys, rerunnable: ctx.rerunnable, rejections: ctx.rejections, intake: ctx.intake(ctx.instanceName), trust: ctx.intakeTrust, yoloMode: ctx.yoloMode, ...(ctx.needsMerge ? { needsMerge: (repo: string) => ctx.needsMerge!(repo) } : {}), changeRule: ctx.changeRule, ...(ctx.landingBranch ? { landingBranch: ctx.landingBranch } : {}),
        jobArtifacts: ctx.jobArtifacts, ...(ctx.jobOpenedPullRequests ? { openedPullRequests: (jobId: string) => ctx.jobOpenedPullRequests!(jobId) } : {}), ...(ctx.jobDoneCriteria ? { doneCriteria: (jobId: string) => ctx.jobDoneCriteria!(jobId) } : {}), ...(ctx.jobAllowedDeletes ? { allowedDeletes: (jobId: string) => ctx.jobAllowedDeletes!(jobId) } : {}), issueGraph: ctx.issueGraph, ...(ctx.gitMirrors ? { gitMirrors: ctx.gitMirrors } : {}), ...(ctx.githubListings ? { listings: ctx.githubListings } : {}), ...(ctx.githubOutbox ? { outbox: ctx.githubOutbox } : {}),
        key: o.account as ConnectedAccountKey, accounts: ctx.connectedAccounts, ...(seam ? { api: seam } : {}),
      }, o);
      return { source, pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default githubAccountPlugin();
