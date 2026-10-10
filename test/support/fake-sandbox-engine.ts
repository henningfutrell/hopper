// A sandbox engine double (issue #603), at the SandboxEngine port: the boxes it holds, in memory. A box it "starts"
// does not join by itself: a test joins it with the join line its spec carries, as the box's client would.
import type { BoxContainer, BoxSpec, SandboxEngine } from '../../src/domain/ports.ts';

export interface FakeSandboxEngine extends SandboxEngine {
  boxes: Map<string, BoxSpec>;
  volumes: Set<string>;
  /** Containers someone else made (no hopper label): their names are taken. */
  others: Set<string>;
  /** Set: why the engine cannot be used. */
  down?: string;
  /** Set: every remove fails with this reason. */
  removeFails?: string;
  /** Set: every launch fails with this reason. */
  launchFails?: string;
}

export function createFakeSandboxEngine(): FakeSandboxEngine {
  const e: FakeSandboxEngine = {
    boxes: new Map(), volumes: new Set(), others: new Set(),
    async problem() { return e.down; },
    async names() { return new Set([...e.boxes.keys(), ...e.others]); },
    async list(labels) {
      return [...e.boxes.values()]
        .filter((b) => Object.entries(labels).every(([k, v]) => b.labels[k] === v))
        .map((b): BoxContainer => ({ name: b.name, labels: { ...b.labels }, state: 'running' }));
    },
    async launch(spec) {
      if (e.launchFails) throw new Error(e.launchFails);
      e.volumes.add(spec.volume);
      e.boxes.set(spec.name, structuredClone(spec));
    },
    async remove(name, volume) {
      if (e.removeFails) throw new Error(e.removeFails);
      e.boxes.delete(name);
      e.volumes.delete(volume);
    },
  };
  return e;
}
