// The sandbox playground's wire shapes (issue #1410, design.md "The sandbox playground"): its limits, a playground
// sandbox and GET /api/sandbox-playground. The playground itself is src/sandbox/playground.ts.

/** One size of a playground sandbox: CPUs (fractions allowed), memory in MiB, time limit in minutes. */
export interface PlaygroundSize { cpus: number; memoryMb: number; ttlMinutes: number }

/** The playground's limits (the chart's `sandbox.*` values). */
export interface PlaygroundLimits {
  /** How many run at once, all users together. */
  maxConcurrent: number;
  /** How many one user runs at once. */
  maxPerUser: number;
  /** What a create gets when it names none, and its template names none. */
  defaults: PlaygroundSize;
  /** The most a create may name. */
  max: PlaygroundSize;
}

/** `starting` until its container runs; `failed`: it did not start, and nothing of it is left; `destroying`: going. */
export type PlaygroundState = 'starting' | 'running' | 'failed' | 'destroying';

export interface PlaygroundSandbox {
  id: string;
  name: string;
  agent: string;
  template?: string;
  /** The image it runs; absent until the start read it. */
  image?: string;
  size: PlaygroundSize;
  state: PlaygroundState;
  createdAt: string;
  expiresAt: string;
  /** Why it failed, or why it is not gone yet. */
  problem?: string;
}

export interface PlaygroundView {
  /** Undefined: sandboxes can start; else why not. */
  problem?: string;
  limits: PlaygroundLimits;
  /** How many run now, all users together, and the user's. */
  running: { all: number; yours: number };
  sandboxes: PlaygroundSandbox[];
}
