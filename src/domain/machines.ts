// Attached machines and attaching one from the UI (design.md "Attached machines", "Machines from
// the UI"; docs/glossary.md "Attached machine", "Machine edit", "Detected ssh target"). An attached
// machine is a machine-source instance of the `ssh`, `docker` or `client` plugin (issue #74).
import type { ActionVia, LaneId, MachineSnapshot } from './types.ts';
import type { UsageLimitPair } from './usage.ts';
// A Windows host (issue #731) is reached over ssh as an ssh target is, but runs only steps: src/domain/windows-steps.ts.
export type { WindowsHost, WindowsHostsView } from './windows-steps.ts';
/**
 * An attached machine as its machine-source instance names it (design.md "Attached machines",
 * "Container targets", "Client targets"): a target reached over ssh, with its own herdr; a container
 * target, which runs commands only, each in a sandbox box of its own; or a client target, a machine running the
 * hopper client that connects back over a reverse tunnel.
 */
export type AttachedMachine = SshMachine | ContainerMachine | ClientMachine;

/** One side of an ssh target's herdr (issue #741): its version and protocol, as `herdr status` prints them. */
export interface HerdrSide { version?: string; protocol?: number }

/** An ssh target's herdr client (and the binary the hopper calls) and the herdr server of its session (issue #741). */
export interface HerdrVersions {
  client?: HerdrSide & { binary?: string };
  server?: HerdrSide;
  /** The herdr the hopper owns there (issue #741): its version, whether every call runs it, and why not or what waits. */
  owned?: { version?: string; inUse: boolean; note?: string };
}

/**
 * The infra credentials its job user's context holds, as its last read found them (issues #1128 part 7, #1248, design.md "Infra
 * credentials on machines"): credential folders and files in its home, a git credential helper, token variables. A machine
 * holding any is not ready: it takes no new job, and Machines, Accounts and Needs you say so. Only the names. `[]`: none.
 * Absent: not read (a container target, a client older than this, offline).
 */
export interface MachineInfraCredentials { infraCredentials?: string[] }

/**
 * A client target that said it leaves (issue #1284, `POST /client/leave`), until it dials in again: no new job is placed
 * on it; the jobs on it run to their end. A lane pod leaves when it is told to stop.
 */
export interface MachineLeaving { leaving?: true }

/**
 * Who drained a machine, the way, and when (issue #1511): kept in the user's settings, per machine id. Issue #2499: why
 * (`reason`), and when it ends by itself (`until`); a drain kept before them has neither, and ends a day after `at`.
 */
export interface MachineDrain { person: string; via: ActionVia; at: string; reason?: string; until?: string }

/** How long a drain lasts when its drain names no hours, and the most it may name (issue #2499). */
export const DRAIN_DEFAULT_HOURS = 24;
export const DRAIN_MAX_HOURS = 720;
/** How long a drained machine stays online with free lanes while a job it could run is queued before it is told (issue #2499). */
export const DRAINED_IDLE_AFTER_MS = 10 * 60_000;

/** When a drain ends by itself: its `until`, or `DRAIN_DEFAULT_HOURS` after it began. */
export const drainEnds = (d: MachineDrain): string => d.until ?? new Date(Date.parse(d.at) + DRAIN_DEFAULT_HOURS * 3_600_000).toISOString();

/** The drained machines (issue #1511), keyed by machine id. */
export type MachineDrains = Readonly<Record<string, MachineDrain>>;

/**
 * A machine a person drained (issue #1511, `POST /ui/api/machines/drain`, `hopper machine drain`), until a person
 * undrains it: no new job is placed on it; the jobs on it run to their end. Kept across restarts. Any machine.
 */
export interface MachineDrained { drained?: MachineDrain }

/**
 * An unhealthy lane (issue #2234, src/engine/lane-health.ts): the last `failures` starts on it failed with the same start
 * error, `error` the last of them, out since `since`. No new job is placed on it until `until`; then one is, and a start
 * that fails the same way puts it out again at once. Kept in memory: a restart forgets it.
 */
export interface UnhealthyLane { laneId: LaneId; failures: number; error: string; since: string; until: string }

/** A machine's unhealthy lanes, as its snapshot (`MachineSnapshot`) carries them (issue #2234). Absent: none. */
export interface MachineLaneHealth { unhealthyLanes?: UnhealthyLane[] }

/** The machines with the drained ones marked at `at` (issue #1511). A drain of a machine not listed, or one ended (issue #2499), marks nothing. */
export const withDrains = <M extends { id: string }>(machines: readonly M[], drains: MachineDrains, at: string): (M & MachineDrained)[] =>
  machines.map((m) => { const d = drains[m.id]; return d && Date.parse(drainEnds(d)) > Date.parse(at) ? { ...m, drained: d } : m; });

/** A machine's herdr, as its snapshot (`MachineSnapshot`) carries it. */
export interface MachineHerdr {
  /**
   * An attached machine's herdr: hopper's session there, herdr found by name (issue #311); this machine's, the herdr session it was added with (issue #260).
   * An ssh target's also carries the herdr client the hopper calls there and the herdr server of its session, as its last probe read them (issue #741).
   */
  herdr?: { session: string } & HerdrVersions;
  /** An ssh target: why its herdr client cannot work with its herdr server, as its last probe found (issue #741): no new job is routed to it. */
  herdrProblem?: string;
}

interface AttachedBase {
  /** The machine id; never `local`. */
  name: string;
  label?: string;
  lanes: number;
  /** Executor instances that can run there. */
  executors: string[];
  /** Its default work tree (issue #324); `~` is its home. Never on a container target. */
  workTree?: string;
  /** A work tree per repository (issue #691), keyed `owner/name`: a job from one of them works there. Never on a container target. */
  workTrees?: Record<string, string>;
  /** When its disk is low (issue #410); absent fields take the defaults. Never on a container target. */
  diskLow?: DiskThresholds;
  /** How the sweep treats it (issue #410); absent fields take the defaults. Never on a container target. `memoryFloor`: its memory floor (issue #2291); absent fields take the defaults. */
  sweep?: SweepSettings; memoryFloor?: import('./memory-floor.ts').MemoryFloor;
  /** Its limits for each job's scope (issue #2498); absent: none. Never on a container target. */
  jobLimits?: import('./job-limits.ts').JobLimits;
  /** Lanes kept for jobs pinned to it (issue #372). */
  reservedLanes?: number;
  /** Lanes specialty jobs may elbow in past its lane cap at once (issue #762). */
  elbowIns?: number;
  /** A Windows machine (issue #1350): the jobs with a Windows label go only to one. */
  windows?: true;
  /** Its own usage limits (issue #1860): its lane cap goes by these, not by the user's. */
  usageLimits?: UsageLimitPair;
}

export interface SshMachine extends AttachedBase {
  /** The ssh destination: a `~/.ssh/config` alias or `user@host`. */
  ssh: string;
  /**
   * It runs herdr: online while its herdr session answers, and herdr-claude runs there. False (issue
   * #142): online while it answers over ssh; only executors that need no herdr run there (cursor-agent, command).
   */
  herdr: boolean;
  /** Its herdr session (never `default`). Unused without `herdr`. herdr itself is called by name there, from its PATH (issue #311). */
  session: string;
  /**
   * Its pinned host key, `<type> <base64>` (design.md "Target authentication", issue #59): the only
   * key the hopper accepts from it. Absent → the hopper does not connect to it.
   */
  hostKey?: string;
}

/**
 * A container target (issues #58, #865): a machine with no agent that runs commands only, each in a one-shot sandbox box
 * the sandbox module starts and burns, on no network.
 */
export interface ContainerMachine extends AttachedBase {
  /** The image each command's box runs. */
  image: string;
}

/**
 * A client target (issues #59, #308): a machine running the hopper client, dialled in to this hopper;
 * herdr calls go down its link, signed with the client token both ends derive from their link keys.
 * Its herdr binary and session are the client's own.
 */
export interface ClientMachine extends AttachedBase {
  /** `key`: its machine key, the public half of its link key — who it is when it dials in. */
  /**
   * Its machine key; the template its join line named (issue #558), when it is a sandbox box of one; the box the
   * hopper started for it (issue #603), when it did; `pool` when it is a lane pod (issue #1284), joined with the lane
   * pool key; the job pod it started (issue #1283), when it is one.
   */
  client: { key: string; template?: string; pool?: true; pod?: string };
}

/**
 * POST /ui/api/machines (design.md "Machines from the UI", issues #18, #74): attach an ssh target as
 * a new `ssh` instance in the plugins config `machines:`. `ssh` must be a detected ssh target; `hostKey`
 * is resolved by the daemon and `session` stays the default — neither is ever sent; it
 * runs herdr only when one of its executors needs it (issue #142). `lanes` and `executors` left out
 * are the machine defaults. A machine is edited and removed like any plugin instance (POST
 * /ui/api/plugins). `version` is `MachinesConfig.version`.
 *
 * An `ssh` target that is this machine (issue #275, `MachinesConfig.ssh.here`) is added as this machine
 * the same way, with no ssh.
 *
 * Without `ssh` (issue #260) it adds **this machine**: a `local` instance under `name`, its jobs in the
 * herdr session `session` (default `hopper`), which the daemon starts; `lanes` left out is four,
 * `executors` left out every registered one. Refused while a machine is this one already.
 */
/** A pinned host key: `<type> <base64>`, as a host's `ssh_host_*_key.pub` holds it (comment dropped). */
export const HOST_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;

/** A herdr session name (issue #260): plain, so it is also a file name and a unit name. Never `default`. */
export const HERDR_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * With `ssh`, `hostKey` (issue #293) is the host key the person confirmed from its fingerprint
 * (`HostKeyOffer`): the pin. Absent: the one ~/.ssh/known_hosts holds for the target.
 */
export interface MachineEdit { name: string; ssh?: string; session?: string; lanes?: number; executors?: string[]; label?: string; hostKey?: string; version: string }

/**
 * POST /ui/api/machines/host-key (issue #293): the host key a new ssh target would be pinned to, and its
 * fingerprint for the person to check on the machine. `known`: ~/.ssh/known_hosts already trusts it;
 * otherwise it is the key the target presents now, pinned only once the person confirms it.
 */
export interface HostKeyOffer { ssh: string; hostKey: string; fingerprint: string; known: boolean }

export type HostKeyOfferOutcome = { ok: true; offer: HostKeyOffer } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/**
 * The **machine defaults** (issue #142): what a machine attached from the UI starts with — the plugins config
 * `machineDefaults:`; a field left out is the `ssh` plugin's own default (one lane, herdr-claude).
 */
export interface MachineDefaults { lanes: number; executors: string[] }

/** POST /ui/api/machines/defaults: the whole `machineDefaults:` section, against `MachinesConfig.version`. */
export interface MachineDefaultsEdit extends MachineDefaults { version: string }

/**
 * A machine as GET /api/machines/config reports it: its name (the machine id), its **connection** —
 * `local` (this machine), `ssh`, `docker`, `client`, or a custom machine source's id — and its
 * options. It is edited and removed through POST /ui/api/plugins, role `machine-source`.
 */
export interface ConfiguredMachine { name: string; connection: string; options?: Record<string, unknown> }

/** GET /api/machines/config: what the Machines view edits. */
export interface MachinesConfig {
  /** sha-256 of the plugins config, or `missing`: a machine edit or a lanes edit carries it back. */
  version: string;
  /** the plugins config could not be used; the last good configuration runs. */
  error?: string;
  /** Every machine as it applies now: this machine (`local`) and each attached one. */
  machines: ConfiguredMachine[];
  /** The configured executor instances: what an attached machine may run. */
  executors: string[];
  /** What a machine attached from the UI starts with. */
  defaults: MachineDefaults;
  /**
   * The detected ssh targets: the Host aliases of ~/.ssh/config; `notes` say what could not be read;
   * `here` (issue #275) those that are this machine, which a machine edit adds as this machine, no ssh;
   * `publicKey` (issue #293) the hopper's own key, to add to a machine's authorized_keys — absent when the
   * runtime mounts the hopper's key, or none could be minted.
   */
  ssh: { targets: string[]; notes: string[]; here: string[]; publicKey?: string };
  /** The daemon's own port (issue #308): where a sandbox box on its network dials in. Absent: not said. */
  port?: number;
  /**
   * Why this machine cannot be added (issue #275), and how to run jobs on the computer the hopper runs
   * on instead: the hopper runs in a container, which is not a machine. Absent: it can be.
   */
  thisMachineRefused?: string;
}

/** A sandbox box the hopper could not stop or remove (issue #603): shown on Machines until it goes. */
export interface CleanupProblem { container: string; reason: string; at: string }

/**
 * GET /api/sandboxes (issues #603, #1349): the user's latest sandbox runs, each sandbox made for one step, and the boxes
 * an older build launched that the hopper could not burn yet.
 */
export interface SandboxesView {
  /** The user's latest sandbox runs, newest first (issue #1349): each sandbox made for one step, and when it was burned. */
  runs: Omit<import('./sandbox-runs.ts').SandboxRun, 'userId'>[];
  problems: CleanupProblem[];
}

export type MachineEditOutcome =
  | { ok: true; config: MachinesConfig }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };

/** A machine's disk (issue #401): bytes free and in all, and whether it is low by the machine's thresholds. */
export type DiskReading = NonNullable<MachineSnapshot['disk']>;

/**
 * A machine's thresholds for a low disk (issue #410): below this many GiB free, or below this share free; absent, 5 GiB and 10%.
 * Critical (issue #2494) below `criticalBelowGiB` or `criticalBelowPercent`; absent, 1 GiB and 2%.
 */
export interface DiskThresholds { belowGiB?: number; belowPercent?: number; criticalBelowGiB?: number; criticalBelowPercent?: number }

/** The statuses a job ends in (`TERMINAL_STATUSES`), each with its own retention (issue #2494). */
export type EndStatus = 'finished' | 'failed' | 'cancelled' | 'rejected';

/**
 * How the sweep treats a machine (issue #410): it is swept every `everyMinutes` (absent, 10), and an ended
 * job's scratch dir there is reaped once it is `scratchMaxAgeHours` old (absent, 24). `retainHours` (issue #2494): for a
 * status named, the job's work stays this many hours from its end instead (`src/domain/retention.ts`).
 */
export interface SweepSettings { everyMinutes?: number; scratchMaxAgeHours?: number; retainHours?: Partial<Record<EndStatus, number>> }

/** A job's side of its machine's link (issue #752, design.md "Link-lost hold"). */
export interface JobMachineLink {
  /**
   * Set while the job is held because its machine's link dropped: it stays `running` on its lane until the link is back
   * and its pane is alive, or it fails at `failsAt` (the link grace). `since`: when the link was found down.
   */
  linkLost?: { machine: string; since: string; failsAt: string };
  /**
   * How many times the lost-machine move took the job off a machine that stayed away (issue #1569). Its proxy token
   * is bound to it: the agent left on that machine holds the token of the move before, which the hopper refuses.
   * Absent: never moved away.
   */
  movedAway?: number;
}

/** The sandbox playground's shapes (issue #1410): no machine, but shown on Machines. */
export type { PlaygroundLimits, PlaygroundSandbox, PlaygroundSize, PlaygroundState, PlaygroundView } from './sandbox-playground.ts';
