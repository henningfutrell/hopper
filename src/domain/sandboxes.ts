// Sandbox boxes the hopper launches (issue #603, design.md "Sandbox boxes the hopper launches"): the sandbox engine
// port, and what it starts a box as.

/** A box container as the sandbox engine lists it: its name, its labels, its state (`running`, `exited`, …). */
export interface BoxContainer { name: string; labels: Record<string, string>; state: string }

/**
 * What the hopper launches a sandbox box as. Only these vary: the engine always applies the sandbox flags of the
 * box line — every capability dropped, no new privileges, a read-only root, `/tmp` a tmpfs, the home the volume,
 * nothing of the computer mounted.
 */
export interface BoxSpec { name: string; image: string; network: string; volume: string; env: Record<string, string>; labels: Record<string, string> }

/** The sandbox engine: rootless Podman, through its API socket. The hopper starts, lists and removes its boxes here. */
export interface SandboxEngine {
  /** Why boxes cannot be launched through it now (no socket, not rootless, not reached); undefined: they can. */
  problem(): Promise<string | undefined>;
  /** Every container's name, whoever made it: a new box takes a free one. */
  names(): Promise<Set<string>>;
  /** The containers that carry every one of these labels. */
  list(labels: Record<string, string>): Promise<BoxContainer[]>;
  /** Pull the image when it is missing, make the volume, create the box and start it. */
  launch(spec: BoxSpec): Promise<void>;
  /** Stop the container and remove it, with its volumes; one already gone is no error. */
  remove(name: string, volume: string): Promise<void>;
}
