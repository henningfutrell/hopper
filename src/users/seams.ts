// The doubles a user's runtime takes at its ports.ts seams (issue #158), for integration tests. Production passes none.
import type { IssueDrafter } from '../issue-drafts/index.ts';
import type { EscalationLevel, Executor, JobSource, PluginsView, Router, SettableUsageSource, TopologyReader, WindowsStepHost } from '../domain/ports.ts';
import { BUILTIN_PLUGINS } from '../plugins/builtin.ts';
import { herdrClaudePlugin } from '../plugins/executor/herdr-claude/index.ts';
import { kubernetesPlugin } from '../plugins/executor/kubernetes/index.ts';
import { kubernetesMachinePlugin } from '../plugins/machine-source/kubernetes-cluster/index.ts';
import type { KubernetesPods } from '../domain/pods.ts';
import { githubAccountPlugin } from '../plugins/job-source/github-account/index.ts';
import { localPlugin } from '../plugins/machine-source/local/index.ts';
import { grokbotRoutinePlugin } from '../plugins/notifier/grokbot-routine/index.ts';
import type { Outbound } from '../outbound/index.ts';
import type { AttachedMachine, HostKeyOffer, JevChooser, TldrWriter } from '../domain/types.ts';
import type { HerdrClient } from '../executors/herdr/index.ts';
import type { MachineProbe, ResolvedTarget } from '../machines/index.ts';
import type { GitHubApi } from '../sources/index.ts';

/** Doubles at ports.ts seams for one user's parts, for integration tests. Production passes none. */
export interface UserSeams {
  /** Replaces the herdr CLI client of every herdr-claude executor instance (detection then says available). */
  herdr?: HerdrClient;
  /** A herdr of its own for each named herdr session of this machine (a machine added with `session`), so each fails apart (issue #1569). Others: `herdr`. */
  herdrSessions?: Readonly<Record<string, HerdrClient>>;
  /** Replaces the Kubernetes API of the job pods (issue #1283): the `kubernetes` executor and the `kubernetes-cluster` machine. */
  kubernetes?: (namespace?: string) => KubernetesPods;
  /** Registered after the configured executor instances. */
  executors?: Executor[];
  /** Replaces the connected account's adapter of every github-account job source; the account still has to be connected. */
  github?: GitHubApi;
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
  /** Replaces Jev (TypeSafe through jev_pick.py) for the decider calls (issue #550). */
  jev?: JevChooser;
  /** Replaces the probe of every attached machine: online = its herdr session (ssh) or its container (docker) is running. */
  machineProbe?: (machine: AttachedMachine) => Promise<MachineProbe>;
  /** How often a machine is probed again (default 30 s): a test that waits on a probe's change sets it short. */
  machineProbeEveryMs?: number;
  /** How often the item reconciler checks (issue #1891; default 5 minutes): a crash test that waits on a correction sets it short. */
  itemReconcileEveryMs?: number;
  /** Replaces resolving a new ssh target when the UI adds a machine (issues #18, #59): its pinned host key once herdr is found there, or a rejection with the reason. */
  resolveTarget?: (ssh: string, o: { herdr: boolean; hostKey?: string }) => Promise<ResolvedTarget>;
  /** Replaces reading the host key a new ssh target would be pinned to (issue #293): known_hosts, else what it presents. */
  hostKeyOffer?: (ssh: string) => Promise<HostKeyOffer>;
  /** Replaces starting this machine's herdr session (issue #260): when it is added, and while it is a machine. */
  herdrSession?: (session: string) => Promise<void>;
  /** Replaces this machine's resource meter (issue #2291): the memory the memory floor reads. */
  localResources?: () => import('../domain/types.ts').ResourceReading | undefined;
  /** The job stream (issue #613): above how many bytes an event goes out as a pointer (default INLINE_MAX). */
  jobStream?: { inlineMax?: number };
  /** Replaces the TL;DR's model (issue #569; default Claude Haiku through the `claude` CLI). */
  tldrWriter?: TldrWriter;
  /** Replaces the model review's model (issue #2846 part 3; default the `claude` CLI). */
  modelReviewWriter?: import('../domain/model-review.ts').ModelReviewWriter;
  /** Replaces File an issue's drafter (issue #471; default the user's own `claude` CLI). */
  issueDrafter?: IssueDrafter;
  /** Replaces the Windows host a step runs on (issue #731; default ssh and scp to the host). */
  windowsStepHost?: WindowsStepHost;
  /** The `claude` the hopper's Claude sign-in for pods runs `setup-token` with (issue #1287; default `claude` on PATH), and variables it gets besides its own. */
  setupToken?: { file: string; env?: Record<string, string> };
  /** Replaces what topology discovery reads AWS and Kubernetes with (issue #1781 part 3; default the AWS SDK and the Kubernetes API). */
  topologyReader?: TopologyReader;
}

/**
 * The built-in plugins with the seams (tests) in place of the herdr CLI and the GitHub adapters, the user's herdr session
 * as herdr-claude's default, and the user's outbound sends for the Grok Bot routine (issue #1014).
 */
export function withSeams(seams: UserSeams, outbound: Outbound) {
  return BUILTIN_PLUGINS.map((p) => {
    if (p.id === 'herdr-claude') return herdrClaudePlugin(seams.herdr, seams.herdrSessions);
    if (p.id === 'kubernetes' && seams.kubernetes) return kubernetesPlugin({ pods: seams.kubernetes, ...(seams.herdr ? { herdr: seams.herdr } : {}) });
    if (p.id === 'kubernetes-cluster' && seams.kubernetes) return kubernetesMachinePlugin(seams.kubernetes);
    if (p.id === 'local' && (seams.herdrSession || seams.localResources)) return localPlugin(seams.herdrSession, seams.localResources);
    if (p.id === 'github-account' && seams.github) return githubAccountPlugin(seams.github);
    if (p.id === 'grokbot-routine') return grokbotRoutinePlugin({ ...seams.grokbot, outbound });
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
