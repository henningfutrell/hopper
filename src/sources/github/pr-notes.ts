// What the hopper says on a job's pull request (issue #1143, design.md "Pull request housekeeping"): one comment for each
// thing it does with it, so the pull request itself shows it — a tend job started, moved to the landing branch, closed as
// superseded. Fixed text, no model call; it names no person and carries no personal or machine details.
import type { TendStep } from '../../domain/types.ts';

/** A tend job started on the pull request (issue #736): it rebases it onto its base branch, or fixes its failing checks. */
export const tendNote = (step: TendStep): string => step === 'rebase'
  ? 'The hopper started a job that rebases this pull request onto its base branch and resolves the merge conflicts.'
  : 'The hopper started a job that fixes the failing checks of this pull request.';

/** The pull request moved from base `from` to the landing branch `to`. */
export const retargetNote = (from: string, to: string): string =>
  `The hopper changed the base branch of this pull request from \`${from}\` to \`${to}\`. \`${to}\` is the landing branch: changes merge there first.`;

/** The pull request closed without a merge: nothing is left to land, `why`. */
export const supersededNote = (why: string): string => `The hopper closed this pull request: ${why}. Nothing is left to land.`;

/**
 * A second pull request of an item closed without a merge (issue #1208): it has merge conflicts, and the item's job follows
 * pull request `followed`, the one the hopper tends.
 */
export const secondPullRequestNote = (followed: number): string =>
  `The hopper closed this pull request: it has merge conflicts, and the work on its issue continues in #${followed}, which a job of the hopper follows. The hopper tends only that pull request. To keep a change of this one, add it to #${followed}.`;
