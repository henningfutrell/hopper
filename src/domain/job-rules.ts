// The job rules (issue #172): what every job's prompt is told before its work tree and the protocol, as
// GET /api/job-rules reports them. docs/glossary.md "Job rules".

/** The job rules as read now. `version`: sha-256 of the record, or `missing`; an edit carries it back. */
export interface JobRulesView {
  /** What the next job gets: the saved text, or the default while none is saved. */
  text: string;
  version: string;
  /** True while none are saved: jobs get the default. */
  missing: boolean;
  /** The default job rules. */
  default: string;
  /** The lines after the job rules that are not edited: the work tree (named `<work tree>`) and the protocol the hopper reads back. */
  fixed: string[];
}
