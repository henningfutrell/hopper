// The stream types (issue #613): each part that emits stream events registers the types it emits, each with its phase,
// under its own name (`skill.loaded` is the skill broker's). The hopper reads a type's phase and nothing of its payload.
import { STREAM_PHASES, type StreamPhase } from '../domain/job-stream.ts';

export interface StreamTypes {
  /** Registers `owner`'s types: each must start with `<owner>.`, once. Throws otherwise. */
  register(owner: string, types: Readonly<Record<string, StreamPhase>>): void;
  /** A registered type's phase; undefined for one no part registered. */
  phaseOf(type: string): StreamPhase | undefined;
}

/** The hopper's own types: the ends it gives a watch itself. */
export const HOPPER_STREAM_TYPES = {
  /** The watch's deadline passed with no answer. */
  'hopper.expired': 'expired',
  /** The job the watch was of ended. */
  'hopper.ended': 'failed',
} as const satisfies Record<string, StreamPhase>;

export function createStreamTypes(): StreamTypes {
  const phases = new Map<string, StreamPhase>();
  return {
    register(owner, types) {
      for (const [type, phase] of Object.entries(types)) {
        if (!type.startsWith(`${owner}.`) || type.length === owner.length + 1) throw new Error(`stream type ${type} is not ${owner}'s: its types start with ${owner}.`);
        if (phases.has(type)) throw new Error(`stream type ${type} is already registered`);
        if (!(STREAM_PHASES as readonly string[]).includes(phase)) throw new Error(`stream type ${type}: ${String(phase)} is no phase (${STREAM_PHASES.join(', ')})`);
        phases.set(type, phase);
      }
    },
    phaseOf: (type) => phases.get(type),
  };
}
