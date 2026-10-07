// Attached machines and attaching one from the UI (design.md "Attached machines", "Machines from
// the UI"; docs/glossary.md "Attached machine", "Machine edit", "Detected ssh target"). An attached
// machine is a machine-source instance of the `ssh`, `docker` or `client` plugin (issue #74).
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
  /** Its default work tree (issue #324); `~` is its home. Never on a container target. */
  workTree?: string;
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

/** A container target (issue #58): a running container on this machine's docker, no agent in it. */
export interface ContainerMachine extends AttachedBase {
  /** The container's name or id: commands run in it through `docker exec`. */
  docker: string;
}

/**
 * A client target (issues #59, #308): a machine running the hopper client, dialled in to this hopper;
 * herdr calls go down its link, signed with the client token both ends derive from their link keys.
 * Its herdr binary and session are the client's own.
 */
export interface ClientMachine extends AttachedBase {
  /** `key`: its machine key, the public half of its link key — who it is when it dials in. */
  client: { key: string };
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

export type MachineEditOutcome =
  | { ok: true; config: MachinesConfig }
  | { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
