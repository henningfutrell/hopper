// Attached machines and editing them from the UI (design.md "Attached machines", "Machines from
// the UI"; docs/glossary.md "Attached machine", "Machine edit", "Detected ssh target").
import type { InstanceSpec } from './plugins.ts';

/**
 * An attached machine as plugins.yaml `attachedMachines:` names it (design.md "Attached machines",
 * "Container targets", "Client targets"): a target reached over ssh, with its own herdr; a container
 * reached over docker exec, which runs commands only; or a client target, a machine running the
 * hopper client that connects back over a reverse tunnel.
 */
export type AttachedMachine = SshMachine | ContainerMachine | ClientMachine;

interface AttachedBase {
  /** The machine id; never `local`. */
  name: string;
  label?: string;
  lanes: number;
  /** Executor instances that can run there. */
  executors: string[];
}

export interface SshMachine extends AttachedBase {
  /** The ssh destination: a `~/.ssh/config` alias or `user@host`. */
  ssh: string;
  /** Its herdr session (never `default`) and herdr binary, as the remote login shell finds it. */
  session: string;
  herdrBin: string;
  /**
   * Its pinned host key, `<type> <base64>` (design.md "Target authentication", issue #59): the only
   * key the hopper accepts from it. Absent → the hopper does not connect to it.
   */
  hostKey?: string;
}

/** A container target (issue #58): a running container on this machine's docker, no agent in it. */
export interface ContainerMachine extends AttachedBase {
  /** The container's name or id: commands run in it through `docker exec`. */
  docker: string;
}

/**
 * A client target (issue #59): a machine running the hopper client, connected back to this one over
 * a reverse tunnel; herdr calls go to it over HTTP, signed with its token. Its herdr binary and
 * session are the client's own.
 */
export interface ClientMachine extends AttachedBase {
  /** `tokenEnv`: the variable (or `<name>_FILE`) the client's token is in, in the hopper's runtime. */
  client: { tokenEnv: string };
}

/**
 * POST /ui/api/machines (design.md "Machines from the UI", issue #18): one attached machine's
 * entry in plugins.yaml. `ssh` must be a detected ssh target; `herdrBin` is resolved over ssh by
 * the daemon and `session` stays the default — neither is ever sent. Edit never changes `ssh`.
 * `version` is `MachinesConfig.version`.
 */
export type MachineEdit =
  | { action: 'add'; name: string; ssh: string; lanes: number; executors?: string[]; label?: string; version: string }
  /** `label: null` drops the label (it falls back to the name). */
  | { action: 'edit'; name: string; lanes?: number; executors?: string[]; label?: string | null; version: string }
  | { action: 'remove'; name: string; version: string };

/** GET /api/machines/config: what the Machines view edits. */
export interface MachinesConfig {
  /** The config document it is written to: `plugins.yaml`. */
  document: string;
  /** sha-256 of plugins.yaml, or `missing`: a machine edit or a lanes edit carries it back. */
  version: string;
  /** plugins.yaml could not be used; the last good configuration runs. */
  error?: string;
  /** The machine source's instance: this machine; its `lanes` option is the lane count. */
  machine: InstanceSpec;
  /** plugins.yaml `attachedMachines:` as it applies now. */
  attached: AttachedMachine[];
  /** The configured executor instances: what an attached machine may run. */
  executors: string[];
  /** The detected ssh targets: the Host aliases of ~/.ssh/config; `notes` say what could not be read. */
  ssh: { targets: string[]; notes: string[] };
}

export type MachineEditOutcome =
  | { ok: true; config: MachinesConfig }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
