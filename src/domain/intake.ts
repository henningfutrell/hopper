// Intake outcomes (issue #440): every open item a job source lists in its scope is taken, or not taken for
// one stated reason, so nothing is dropped without saying why. A claim names its holder (a claim holder id
// per user of a hopper), so a stale claim of the user's own is released and a live one of another hopper is
// respected. The intake migration moves a source's existing items to these rules once, and lists what it changed.

/** What became of one open item in a source's scope. */
export interface IntakeOutcome {
  /** The item's source key (a GitHub issue's URL). */
  key: string;
  title: string;
  /** owner/repo, for a GitHub item. */
  repo?: string;
  /** Absent: taken. Otherwise the one reason it is not. */
  reason?: string;
  /** What the user can do about it from the Sources view. */
  action?: IntakeActionKind;
  /** The item's job, when it was taken and has one (the sync loop fills it). */
  jobId?: string;
}

/** `assign`: assign the item to the user's connected account. `release`: release a claim no job here holds. */
export type IntakeActionKind = 'assign' | 'release';

export interface IntakeAction {
  kind: IntakeActionKind;
  keys: string[];
}

export interface IntakeActionResult {
  done: string[];
  /** Key → why it was not done. */
  failed: Record<string, string>;
}

/** One change the intake migration made, or one item it found needing the user. */
export interface IntakeChange {
  key: string;
  change: string;
}

/** The intake migration of one source, once done: when, and what it changed. */
export interface IntakeMigration {
  at: string;
  changes: IntakeChange[];
}

/** Repos the connected account can reach, outside the source's scope, with open items for the user there (issue #440). */
export interface OutsideRepo {
  repo: string;
  /** The keys of those items. */
  items: string[];
}

/** The events intake records (issue #440). */
export type IntakeEventType = 'source.claim_released' | 'source.intake_migrated' | 'source.issues_assigned';

/** What a job source learns for its intake (issue #440), for its own instance name. */
export interface IntakeContext {
  /** This user's claim holder id: random, the same for every source of the user, naming no person or machine. */
  holder: string;
  /** Of these keys, those another user of this hopper has a job for. */
  othersKnown(keys: string[]): Set<string>;
  /** The source's intake migration, once done; undefined until then. */
  migration(): IntakeMigration | undefined;
  migrated(m: IntakeMigration): void;
  record(type: IntakeEventType, data: Record<string, unknown>): void;
}
