// Attached machines and attaching one from the UI (design.md "Attached machines", "Machines from
// the UI"; docs/glossary.md "Attached machine", "Machine edit", "Detected ssh target"). An attached
// machine is a machine-source instance of the `ssh`, `docker` or `client` plugin (issue #74).
import type { InstanceSpec } from './plugins.ts';

/**
 * An attached machine as its machine-source instance names it (design.md "Attached machines",
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
 * POST /ui/api/machines (design.md "Machines from the UI", issues #18, #74): attach an ssh target as
 * a new `ssh` instance in plugins.yaml `machines:`. `ssh` must be a detected ssh target; `herdrBin`
 * and `hostKey` are resolved by the daemon and `session` stays the default — none is ever sent. A
 * machine is edited and removed like any plugin instance (POST /ui/api/plugins). `version` is
 * `MachinesConfig.version`.
 */
export interface MachineEdit { name: string; ssh: string; lanes: number; executors?: string[]; label?: string; version: string }

/** GET /api/machines/config: what the Machines view edits. */
export interface MachinesConfig {
  /** The config document it is written to: `plugins.yaml`. */
  document: string;
  /** sha-256 of plugins.yaml, or `missing`: a machine edit or a lanes edit carries it back. */
  version: string;
  /** plugins.yaml could not be used; the last good configuration runs. */
  error?: string;
  /** Every machine-source instance as it applies now: this machine (`local`) and each attached one. */
  machines: InstanceSpec[];
  /** The configured executor instances: what an attached machine may run. */
  executors: string[];
  /** The detected ssh targets: the Host aliases of ~/.ssh/config; `notes` say what could not be read. */
  ssh: { targets: string[]; notes: string[] };
}

export type MachineEditOutcome =
  | { ok: true; config: MachinesConfig }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
