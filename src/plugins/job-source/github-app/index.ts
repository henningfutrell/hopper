// github-app: the same GitHub source posting as hopper's GitHub App; the repos the app is
// installed on are the allowlist (design.md "Phase 4"). Its instance is named `github-app`: jobs and
// sync state are keyed by it. Detection checks the app's identity only: `appId` and `slug` in the
// options, its private key in the environment (design.md "Secrets"). Without them the source still
// runs, paused, and starts on its own once they are set.
import type { GitHubApi } from '../../../sources/index.ts';
import { appProblem, createAppSource, githubAppOptions, loadGitHubApp, type GitHubAppOptions } from '../../../sources/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

const CREATE_APP = 'scripts/create-github-app.sh (from the hopper checkout), then set appId and slug on this instance in Plugins and the key in the environment';

/** The plugin. `seam` (tests, `AppSeams.githubApp`) replaces the App adapter; detection then says available. */
export function githubAppPlugin(seam?: GitHubApi): PluginDefinition<'job-source', GitHubAppOptions> {
  return {
    id: 'github-app',
    role: 'job-source',
    describe: "GitHub issues labelled hopper in the repos hopper's GitHub App is installed on, posting as the app",
    options: () => githubAppOptions,
    async detect(sys, o) {
      if (seam) return { status: 'available', detail: 'GitHub seam (tests)' };
      const load = loadGitHubApp({
        ...(o.appId === undefined ? {} : { appId: o.appId }), ...(o.slug === undefined ? {} : { slug: o.slug }),
        privateKeyEnv: o.privateKeyEnv, privateKey: sys.env(o.privateKeyEnv),
      });
      const problem = appProblem(load);
      if (problem) return { status: 'needs-setup', reason: problem, command: CREATE_APP };
      return { status: 'available', detail: `${o.slug} (app ${o.appId}), key from ${o.privateKeyEnv}` };
    },
    create(ctx, o) {
      if (!o.enabled) return { disabled: { kind: 'github-app', detail: { mode: 'app' } } };
      const source = createAppSource({
        name: ctx.instanceName, clock: ctx.clock, knownKeys: ctx.knownKeys, rerunnable: ctx.rerunnable, env: ctx.env,
        ...(seam ? { api: seam } : {}),
      }, o);
      return { source, pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default githubAppPlugin();
