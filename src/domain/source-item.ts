// A source item — what a job source offers, which becomes at most one job — and the source as the host takes it
// (design.md "Job sources"). Apart from ports.ts for its size; re-exported there.
import type { ItemComment, ItemEdit, ItemText } from './item-snapshots.ts';

/** One eligible item a source offers. Becomes at most one job, deduped by `key`. */
export interface SourceItem {
  key: string;
  url: string;
  title: string;
  /** The raw item text (issue body). */
  body: string;
  /**
   * The full prompt sent to the job: `body` followed by the item context (repo, number, URL,
   * title, labels, author, priority and where it came from, project item, recent comments)
   * and instructions for commenting back. Built by the source.
   */
  prompt: string;
  /** Environment for the job's process, e.g. HOPPER_ISSUE_URL, HOPPER_REPO, HOPPER_ISSUE_NUMBER. */
  env: Record<string, string>;
  author: string;
  /** The login the item was taken for (issue #387: an issue assigned to the user's connected account). */
  assignee?: string;
  priority: number;
  /** Where `priority` came from, e.g. "project:Priority=P1", "label:hopper:high", "default". */
  priorityReason: string;
  labels: string[];
  /** Its GitHub repository (`owner/name`) when it has one: a job's is fetched or cloned in its work tree (issue #361). */
  repo?: string;
  number?: number;
  /** Executor for the job (from source config), and an optional model. */
  executor: string;
  model?: string;
  /**
   * Set when the item cannot become a runnable job (e.g. "empty issue body"). `ingest` then
   * creates the job and fails it in one tx (job.queued + job.failed), so it is claimed and
   * reported failed once — never retried every poll. An executor rejecting the payload is
   * treated the same way.
   */
  invalid?: string;
  /**
   * The item's text as read (issue #662): what its snapshot records and is compared with. `comments` absent: the source
   * did not read them this time (an item whose job has not ended); compared as the snapshot's. `edits`: who edited the
   * item since its snapshot, set by the sync loop when the text changed (`JobSource.editsSince`). Absent: the source keeps
   * no snapshot of its items.
   */
  text?: { title: string; body: string; comments?: ItemComment[]; edits?: ItemEdit[] };
}

/** A source as the host takes it: its name and kind, and how it renders an item from a text (`JobSource.withText`). */
export interface SourceRef {
  name: string;
  kind: string;
  withText?: (item: SourceItem, text: ItemText) => SourceItem;
}
