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

/** How the decider paces usage against each usage window's reset (issue #373, design.md "Usage pacing"). */
export interface UsagePacing {
  /** The burn window: within this many ms of a week window's reset, it stops throttling unless spent. 0: off. */
  burnWindowMs: number;
  /** Reset-aware placement: pick the machine with the most placement pressure first. */
  resetAwarePlacement: boolean;
  /** The critical priority: a job at or above it that fits nowhere may take one lane over the cap. 0: off. */
  criticalPriority: number;
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
  /** The tool read that it is signed in as nobody (issue #1128): a sign-in is needed, not a fix. */
  signedOut?: true;
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
  /** When it last read the account (issue #1128): each read, with or without readings. */
  accountReadAt?: string;
  /** The executor instances whose jobs its budgets limit; absent: every job. */
  executors?: string[];
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

/** The usage limits (issue #522): the usage fraction where a machine's lanes scale down (soft) and where it starts nothing (hard). */
export interface UsageLimitPair {
  soft: number;
  hard: number;
}

/** The usage limits the decider uses now: the user's, once set in the UI, else the defaults (HOPPER_SOFT_LIMIT / HOPPER_HARD_LIMIT). */
export interface UsageLimits extends UsageLimitPair {
  defaults: UsageLimitPair;
  /** True once the user set them: they win over the defaults from then on. */
  set: boolean;
}

/** `GET /api/usage`: every reading, every usage source's state, the limits, and the lane effect per machine. */
export interface UsageReport {
  readings: UsageReading[];
  sources: UsageSourceReport[];
  limits: UsageLimits;
  machines: MachineLaneEffect[];
}

// Tool accounts (issue #1128, design.md "Tool accounts"): the account each machine's agent tool is signed in as, one entry per
// service and identity, gathered from the usage sources' accounts.

/** What a machine's tool says of its sign-in: signed in as the account, signed in as nobody, or not known (no read, a read failed). */
export type ToolLogin = 'signed-in' | 'signed-out' | 'unknown';

/** One machine that uses a tool account: what its usage source last read there. */
export interface ToolAccountMachine {
  machineId: string;
  /** The machine's label; its id when it is not configured now. */
  label: string;
  /** The usage source that reads the tool there. */
  source: string;
  login: ToolLogin;
  /** Why the login is not known, or why the source has no readings now. */
  problem?: string;
  /** When the source last read the account there. */
  readAt?: string;
  /** When a job of the source's executors last started there. */
  lastUsedAt?: string;
}

/** One tool account: a service and the identity its machines are signed in as. No identity: the machines signed in as nobody. */
export interface ToolAccount {
  service: string;
  identity?: string;
  /** Plain facts the tool gave: plan, organization, sign-in method. */
  detail: Record<string, string | string[]>;
  /** signed-in when any machine is; signed-out when every machine read is; else unknown. */
  login: ToolLogin;
  machines: ToolAccountMachine[];
  /** The latest `lastUsedAt` of its machines. */
  lastUsedAt?: string;
  /** Its week windows (spend): the newest reading of each window over its machines, throttling ones first. */
  spend: UsageReading[];
}

/** `GET /api/tool-accounts`. */
export interface ToolAccountsReport { accounts: ToolAccount[] }
