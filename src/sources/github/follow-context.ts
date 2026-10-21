// The contexts of a pull request's follow (follow.ts, direct-follow.ts): what each needs from its source.
import type { Clock } from '../../domain/ports.ts';
import type { ChangeRule, Job } from '../../domain/types.ts';
import type { PullRequestState } from './api.ts';
import type { LabelDrift } from './item-labels.ts';
import type { ReportContext } from './report.ts';

/**
 * What following a pull request needs beyond the report's: whether the hopper may merge in a repository (yolo mode), and
 * the clock for the no-checks grace window (issue #677; absent: the system clock). A direct job's follow needs it too; it
 * has no issue, so no labels.
 */
export interface PullRequestContext extends ReportContext {
  yoloMode?: (repo: string) => boolean;
  /** A repository's landing branch (issue #1143, its landing batch setting); absent or undefined: no pull request is moved. */
  landingBranch?: (repo: string) => string | undefined;
  /** The change rule of a repository (issue #1076); absent: the built-in rule. */
  changeRule?: (repo: string) => ChangeRule;
  clock?: Clock;
  /** The batch's answer for pull request `number` of `repo`, taken once (issue #985); absent or undefined: read GitHub. */
  batched?: (repo: string, number: number) => PullRequestState | undefined;
  /**
   * Why the hopper does not merge job `job`'s ready pull request `url` of `repo` itself (issue #1924 part 3): its done criteria
   * not met now, or a person merges it. Absent or undefined: it merges.
   */
  mergeHold?: (job: Job, repo: string, url: string) => Promise<string | undefined>;
}

/** What the follow of a job's pull request on its issue needs. */
export interface FollowContext extends PullRequestContext {
  /**
   * Keeps the label change of a follow's end on item `key` of `repo` (issue #1892 part 14), tagged with the end, and sends
   * it: the GitHub outbox's rows (act `follow`). A change of that end on its way already is not kept twice.
   */
  labels: (key: string, repo: string, change: LabelDrift, tag: string) => Promise<void>;
}
