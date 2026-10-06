// Usage and accounts on the wire (design.md "Usage and accounts (issue #18)"): what a usage source
// says beside its readings, the usage report, and who each part acts as. Re-exported by types.ts.
import type { MachineId } from './types.ts';

/** One usage budget reading. `used`/`limit` share a unit; `unit` names it. */
export interface UsageReading {
  source: string;
  /** Machine the budget constrains; absent = applies to every machine. */
  machineId?: MachineId;
  /** Executor instances whose jobs the budget limits (one agent framework's, as a rule); absent = every job. */
  executors?: string[];
  used: number;
  limit: number;
  unit: string;
  /** ISO time the window resets, if known. */
  resetsAt?: string;
  /** The usage window it measures, as the source names it (`session`, `week`, `week (Fable)`); absent = the source's one budget. */
  window?: string;
  /** Shown, never throttling: it limits one model only (glossary "Informational reading"); decider step 1 skips it. */
  informational?: true;
  at: string;
}

/** Who a part acts as on an outside service (glossary "Account"). Facts only: never a token or a key. */
export interface Account {
  /** The outside service: `claude`, `github`. */
  service: string;
  /** The email or login it acts as; absent while not known. */
  identity?: string;
  /** Plain facts: plan, organization, sign-in method; for a GitHub App, the app and its installation repos. */
  detail: Record<string, string | string[]>;
  /** Why the identity is not known or not in use (not logged in, paused, disabled). */
  problem?: string;
}

/** An account and the part that uses it: one entry of `GET /api/accounts`. */
export interface PartAccount extends Account {
  role: 'usage-source' | 'job-source';
  /** The instance name in the plugins config. */
  instance: string;
}

/** What a usage source says about itself beside its readings (`UsageSource.state`). */
export interface UsageSourceState {
  /** When it last read its budgets. */
  refreshedAt?: string;
  /** Why it has no readings now: not read yet, unavailable, stale. */
  problem?: string;
  /** Who it reads the budgets for. */
  account?: Account;
}

/** A usage source in `GET /api/usage`: its instance name and state. */
export interface UsageSourceReport extends UsageSourceState {
  name: string;
}

/** What usage does to the jobs of one executor on a machine: the readings that limit that executor. */
export interface ExecutorLaneEffect {
  executor: string;
  usedFrac: number;
  /** The most lanes its jobs may hold there. */
  cap: number;
  band: 'offline' | 'free' | 'soft' | 'hard';
}

/**
 * What usage does to one machine's lanes now: the decider's steps 1 and 2 over the current readings.
 * The machine's own figures are its least limited executor's: lanes stay open while any of its
 * executors may run.
 */
export interface MachineLaneEffect {
  machineId: string;
  label: string;
  online: boolean;
  maxLanes: number;
  /** Max of used/limit over the readings that throttle this machine. */
  usedFrac: number;
  /** The lane cap: maxLanes below the soft limit, scaled down past it, 0 at the hard limit or offline. */
  cap: number;
  band: 'offline' | 'free' | 'soft' | 'hard';
  /** Per executor the machine runs, in its order. */
  executors: ExecutorLaneEffect[];
}

/** `GET /api/usage`: every reading, every usage source's state, the limits, and the lane effect per machine. */
export interface UsageReport {
  readings: UsageReading[];
  sources: UsageSourceReport[];
  limits: { soft: number; hard: number };
  machines: MachineLaneEffect[];
}
