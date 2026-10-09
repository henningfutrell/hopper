// The doubles a user's runtime takes at its ports.ts seams (issue #158), for integration tests. Production passes none.
import type { EscalationLevel, Executor, JobSource, PluginsView, Router, SettableUsageSource } from '../domain/ports.ts';
import { BUILTIN_PLUGINS } from '../plugins/builtin.ts';
import { herdrClaudePlugin } from '../plugins/executor/herdr-claude/index.ts';
import { githubAppPlugin } from '../plugins/job-source/github-app/index.ts';
import { githubAccountPlugin } from '../plugins/job-source/github-account/index.ts';
import { localPlugin } from '../plugins/machine-source/local/index.ts';
import { grokbotRoutinePlugin } from '../plugins/notifier/grokbot-routine/index.ts';
import type { AttachedMachine, HostKeyOffer } from '../domain/types.ts';
import type { HerdrClient } from '../executors/herdr/index.ts';
import type { MachineProbe, ResolvedTarget } from '../machines/index.ts';
import type { GitHubApi } from '../sources/index.ts';

/** Doubles at ports.ts seams for one user's parts, for integration tests. Production passes none. */
export interface UserSeams {
  /** Replaces the herdr CLI client of every herdr-claude executor instance (detection then says available). */
  herdr?: HerdrClient;
  /** Registered after the configured executor instances. */
  executors?: Executor[];
  /** Replaces the connected account's adapter of every github-account job source; the account still has to be connected. */
  github?: GitHubApi;
  /** Replaces the App adapter of every github-app job source (detection says available; paused() still follows the app file). */
  githubApp?: GitHubApi;
  /** A hand-settable usage source the decider reads, set through `engine.setFakeUsage` (tests). */
  fakeUsage?: SettableUsageSource;
  /** Run after the configured sources, polled every SEAM_SOURCE_POLL_MS. */
  sources?: JobSource[];
  /** Every grokbot-routine notifier instance's first retry delay (default 1000) and configured check (default 5000), in ms. */
  grokbot?: { baseMs?: number; watchMs?: number };
  /** Replaces the configured router (the plugin host still loads, for /api/plugins). */
  router?: Router;
  /** Replace the configured escalation levels, lowest first; [] = none. The report stays the host's. */
  levels?: EscalationLevel[];
  /** Replaces the probe of every attached machine: online = its herdr session (ssh) or its container (docker) is running. */
  machineProbe?: (machine: AttachedMachine) => Promise<MachineProbe>;
  /** Replaces resolving a new ssh target when the UI adds a machine (issues #18, #59): its pinned host key once herdr is found there, or a rejection with the reason. */
  resolveTarget?: (ssh: string, o: { herdr: boolean; hostKey?: string }) => Promise<ResolvedTarget>;
  /** Replaces reading the host key a new ssh target would be pinned to (issue #293): known_hosts, else what it presents. */
  hostKeyOffer?: (ssh: string) => Promise<HostKeyOffer>;
  /** Replaces starting this machine's herdr session (issue #260): when it is added, and while it is a machine. */
  herdrSession?: (session: string) => Promise<void>;
}

/** The built-in plugins with the seams (tests) in place of the herdr CLI and the GitHub adapters, and the user's herdr session as herdr-claude's default. */
export function withSeams(seams: UserSeams) {
  return BUILTIN_PLUGINS.map((p) => {
    if (p.id === 'herdr-claude') return herdrClaudePlugin(seams.herdr);
    if (p.id === 'local' && seams.herdrSession) return localPlugin(seams.herdrSession);
    if (p.id === 'github-account' && seams.github) return githubAccountPlugin(seams.github);
    if (p.id === 'github-app' && seams.githubApp) return githubAppPlugin(seams.githubApp);
    if (p.id === 'grokbot-routine' && seams.grokbot) return grokbotRoutinePlugin(seams.grokbot);
    return p;
  });
}

/** A seam router (tests) answers as itself; the report stays the host's. */
export function seamPlugins(router: Router, host: PluginsView): PluginsView {
  return {
    routerStatus: () => ({ name: router.name, plugin: router.name, fallback: false }), report: host.report, edit: host.edit,
    machinesConfig: host.machinesConfig, editMachines: host.editMachines, machineHostKey: host.machineHostKey, editMachineDefaults: host.editMachineDefaults,
    routing: host.routing, editRouting: host.editRouting, notifierAction: host.notifierAction,
  };
}
