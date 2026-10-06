// Routing rules (design.md "Routing rules (issue #18)"; docs/glossary.md "Routing rule"): the plugins config
// `routing:`, an ordered list applied at intake. The first matching rule sets a job's machine pin,
// executor and/or priority. Never a lane.

/** What a rule matches; every field given must match (case-insensitive). None given: every item. */
export interface RoutingMatch {
  /** The job-source instance name, exactly (any case). */
  source?: string;
  /** `owner/name`; `*` matches any run of characters. */
  repo?: string;
  /** The item has this label. */
  label?: string;
  author?: string;
  /** A substring of the item's title. */
  title?: string;
}

/** What a rule sets on the job; at least one. */
export interface RoutingSet {
  /** A configured machine id: the job's machine pin (`spec.machineId`). */
  machine?: string;
  /** A configured executor instance (`spec.executor`). */
  executor?: string;
  /** 0..100. */
  priority?: number;
}

export interface RoutingRule {
  /** Unique; what `spec.routedBy.rule` names. */
  name: string;
  match: RoutingMatch;
  set: RoutingSet;
}

/** The rule that routed a job at intake, and what it set (`spec.routedBy`). */
export interface RoutedBy {
  rule: string;
  set: RoutingSet;
}

/** The facts of a source item a rule matches. */
export interface RoutingItem {
  source: string;
  repo?: string;
  labels: string[];
  author: string;
  title: string;
}

/** A rule intake would skip now, and why (its machine or executor is not configured). */
export interface SkippedRule {
  rule: string;
  reason: string;
}

/** GET /api/routing. `version` is the plugins config's (as in /api/plugins); an edit carries it back. */
export interface RoutingReport {
  version: string;
  rules: RoutingRule[];
  /** the plugins config could not be read: the last good rules apply. */
  error?: string;
  /** What a rule may name (a save naming anything else is refused). */
  targets: { machines: string[]; executors: string[] };
  skipped: SkippedRule[];
}

/** POST /ui/api/routing: the whole ordered list. */
export interface RoutingEdit {
  rules: RoutingRule[];
  version: string;
}

export type RoutingEditOutcome =
  | { ok: true; report: RoutingReport }
  | { ok: false; code: 'invalid' | 'conflict'; error: string };
