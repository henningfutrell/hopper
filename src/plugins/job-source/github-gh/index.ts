// github-gh: open GitHub issues labelled `hopper` become jobs, through the gh CLI acting as the owner
// (design.md "GitHub source"). Its instance is named `github`: jobs and sync state are keyed by it.
// Detection asks `gh auth status` — free, no paid call. A gh that is installed but not logged in
// still runs (it errors until gh is logged in — from the UI, design.md "gh login" — then works without a restart).
import type { GitHubApi } from '../../../sources/index.ts';
import { createGhSource, githubGhOptions, type GitHubGhOptions } from '../../../sources/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

/** What logs gh in: the UI (any install, a container too), or gh itself on a host. */
export const GH_LOGIN = 'Sources → Log in to GitHub, or gh auth login';

/** The plugin. `seam` (tests, `AppSeams.github`) replaces the gh CLI adapter; detection then says available. */
export function githubGhPlugin(seam?: GitHubApi): PluginDefinition<'job-source', GitHubGhOptions> {
  return {
    id: 'github-gh',
    role: 'job-source',
    describe: 'GitHub issues labelled hopper, through the gh CLI as the owner (pauses while a GitHub App is configured)',
    options: () => githubGhOptions,
    async detect(sys, o) {
      if (seam) return { status: 'available', detail: 'GitHub seam (tests)' };
      const gh = await sys.which(o.bin);
      if (!gh) return { status: 'unavailable', reason: `gh not found: ${o.bin}` };
      if (!(await sys.succeeds(o.bin, ['auth', 'status']))) return { status: 'needs-setup', reason: 'gh is not logged in', command: GH_LOGIN };
      return { status: 'available', detail: gh };
    },
    create(ctx, o) {
      if (o.enabled === false) return { disabled: { kind: 'github', detail: { mode: 'gh', enabledSetting: 'false' } } };
      const source = createGhSource({ name: ctx.instanceName, clock: ctx.clock, knownKeys: ctx.knownKeys, rerunnable: ctx.rerunnable, env: ctx.env, userEnv: ctx.userEnv, ...(seam ? { api: seam } : {}) }, o);
      return { source, pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default githubGhPlugin();
