// The hopper's URL a job is given (issues #563, #695, design.md "GitHub through the hopper"): HOPPER_URL, which hopper-gh,
// git, hopper-skill, hopper-artifact and the job stream all ask at. It must be one the job's machine reaches: the
// hopper's bare container name resolves only inside its own network. Pure.
import { reachBase, type HopperReach } from '../artifacts/links.ts';

/** What the choice reads of a machine: its connection, and a client target's door. */
export interface ReachingMachine { ssh?: unknown; docker?: unknown; client?: { door?: string } }

/**
 * This machine: loopback. A client target: its client door, on loopback there, so its jobs resolve no name; a client
 * with no door (older than issue #695) the URL it dialled in at. Anything else — an ssh or container target, or a client
 * not dialled in yet — `reachBase`: the link base, the public URL, an address or a `.local` name before a bare name.
 * Undefined: the machine reaches the hopper at no URL the hopper knows, and its jobs get no way to it.
 */
export function jobHopperUrl(o: HopperReach & { machine: ReachingMachine; dialled?: string | undefined }): string | undefined {
  const m = o.machine;
  if (m.client) return m.client.door ?? o.dialled ?? reachBase(o);
  if (!m.ssh && !m.docker) return `http://127.0.0.1:${o.port}`;
  return reachBase(o);
}
