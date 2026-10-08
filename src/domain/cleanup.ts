// Deferred cleanup (issue #371, design.md "Deferred cleanup"): what the decider reads of it.

/** An ended job of an item whose cleanup has not gone through yet: its pane and agent may still run. */
export interface CleanupDue {
  jobId: string;
  /** Its item's `source.key`. */
  sourceKey: string;
  /** Why not yet: the deferral's error, or absent while the first try runs. */
  error?: string;
}
