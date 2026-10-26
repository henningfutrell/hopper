// A person's bug reports (issue #694, design.md "Report a bug"): each report the hopper filed for them, or keeps to send
// later, so Settings → Your reports can list it with its state on GitHub.

/**
 * `approval`: a job's report, kept until a person approves it in Your reports (issue #2818); never sent before that.
 * `sending`: kept before GitHub is asked (issue #1591), its id the post key in the text; a stop leaves it so, and the next
 * start makes it `waiting`. `waiting`: kept, not on GitHub yet — the GitHub connection was down or had no access, or its
 * answer was lost; the hopper looks for its post key, then sends it later. `open`, `closed`: the issue on GitHub (for a
 * comment: the issue it was added to), as last read.
 */
export type BugReportState = 'approval' | 'sending' | 'waiting' | 'open' | 'closed';

export interface BugReport {
  id: string;
  createdAt: string;
  /** Who filed it: the person's name, or `job <id>`. */
  by: string;
  jobId?: string;
  fromJob?: boolean;
  title: string;
  state: BugReportState;
  /** `issue`: a new report; `comment`: added to the open report `number`. */
  kind: 'issue' | 'comment';
  /** The issue on GitHub; with `kind: comment` and `waiting`, the issue it goes to. */
  number?: number;
  url?: string;
  /** While `approval`, `sending` or `waiting`: the body to send, scrubbed, without its post key. Dropped once sent. */
  body?: string;
  /** What the scrub removed before it was kept, by kind: a job's private work (issue #2812), any report's identifiers (issue #2818). */
  removed?: string[];
  /** While `waiting`: why it was not sent, from the last try. */
  problem?: string;
  /** Tries to send it so far. */
  tries: number;
  /** When the hopper last tried to send it, or last read its state on GitHub. */
  checkedAt?: string;
  /** While `closed`: when, and why, as GitHub said — `completed` (its fix landed, issue #1147), `not_planned`, `duplicate`. */
  closedAt?: string;
  closedAs?: string;
}

/** A person's bug reports (issue #694): filed, or kept to send later. */
export interface BugReportRepository {
  add(input: Omit<BugReport, 'id'>): BugReport;
  get(id: string): BugReport | undefined;
  /** Newest first, at most `limit` (default 200). */
  list(limit?: number): BugReport[];
  /** The reports in `state`, oldest first. */
  inState(state: BugReportState): BugReport[];
  /** Kept as `id` (a resend key's report, issue #2813), unless a report with that id is there: then undefined. */
  addOnce(id: string, input: Omit<BugReport, 'id'>): BugReport | undefined;
  /** Shallow-merge; `undefined` clears. */
  update(id: string, patch: Partial<Omit<BugReport, 'id'>>): BugReport;
  /** A report GitHub refused for itself goes (issue #1591): it was kept only to be sent. */
  remove(id: string): void;
}
