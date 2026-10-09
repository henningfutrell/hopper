// github-account: issues labelled hopper in the GitHub account the user connected (issue #214,
// design.md "Connected accounts") — read and labelled through that account's token, which the
// hopper's GitHub App was granted when the user approved its device code — signing in with GitHub, or
// connecting it from Sources. Paused until the user
// connects GitHub (Sources → Connect GitHub); nothing to set up here. Its instance is named
// `github-account`: jobs and sync state are keyed by it.
import type { GitHubApi } from '../../../sources/index.ts';
import { createAccountSource, githubAccountOptions, type GitHubAccountOptions } from '../../../sources/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

/** The plugin. `seam` (tests) replaces the account adapter. */
export function githubAccountPlugin(seam?: GitHubApi): PluginDefinition<'job-source', GitHubAccountOptions> {
  return {
    id: 'github-account',
    role: 'job-source',
    describe: 'GitHub issues labelled hopper, through the GitHub account you connect (Sources → Connect GitHub)',
    options: () => githubAccountOptions,
    detect: async () => ({ status: 'available', detail: 'the GitHub account connected in Sources' }),
    create(ctx, o) {
      if (!o.enabled) return { disabled: { kind: 'github-account', detail: { mode: 'account' } } };
      const source = createAccountSource({
        name: ctx.instanceName, clock: ctx.clock, knownKeys: ctx.knownKeys, rerunnable: ctx.rerunnable, rejections: ctx.rejections, env: ctx.env, intake: ctx.intake(ctx.instanceName), yoloMode: ctx.yoloMode,
        provider: 'github', accounts: ctx.connectedAccounts, ...(seam ? { api: seam } : {}),
      }, o);
      return { source, pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default githubAccountPlugin();
