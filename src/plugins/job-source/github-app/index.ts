// github-app: the same GitHub source posting as job-hopper's GitHub App; the repos the app is
// installed on are the allowlist (design.md "Phase 4"). Its instance is named `github-app`: jobs and
// sync state are keyed by it. Detection looks for the app file only. Without it the source still
// runs, paused, and starts on its own once create-github-app.sh writes the file.
import { expandHome } from '../../expand-home.ts';
import type { GitHubApi } from '../../../sources/index.ts';
import { createAppSource, githubAppOptions, type GitHubAppOptions } from '../../../sources/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

const CREATE_APP = 'bash ~/.local/lib/job-hopper/scripts/create-github-app.sh';

/** The plugin. `seam` (tests, `AppSeams.githubApp`) replaces the App adapter; detection then says available. */
export function githubAppPlugin(seam?: GitHubApi): PluginDefinition<'job-source', GitHubAppOptions> {
  return {
    id: 'github-app',
    role: 'job-source',
    describe: "GitHub issues labelled hopper in the repos job-hopper's GitHub App is installed on, posting as the app",
    options: () => githubAppOptions,
    async detect(sys, o) {
      if (seam) return { status: 'available', detail: 'GitHub seam (tests)' };
      const file = expandHome(o.appFile);
      if (!(await sys.exists(file))) return { status: 'needs-setup', reason: `no GitHub App configured: ${file} not found`, command: CREATE_APP };
      return { status: 'available', detail: file };
    },
    create(ctx, o) {
      if (!o.enabled) return { disabled: { kind: 'github-app', detail: { mode: 'app' } } };
      const source = createAppSource({
        name: ctx.instanceName, clock: ctx.clock, knownKeys: ctx.knownKeys, rerunnable: ctx.rerunnable,
        ...(seam ? { api: seam } : {}),
      }, o);
      return { source, pollMs: o.pollSeconds * 1000 };
    },
  };
}

export default githubAppPlugin();
