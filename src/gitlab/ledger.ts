// GitLab's Intake reads the ledger (issue #1892 part 29, design.md "GitLab's Intake reads the ledger"), as GitHub's does
// (discover.ts `ledgerReason`): an issue whose work item is in a state the label mirror judges gets the ledger's reason, whatever
// end labels it carries, and the label mirror (label-mirror.ts) compares its labels with what that state wants and corrects them
// through the GitLab outbox (act `mirror`). An end label a person takes off at GitLab is their Run again
// (`work_item.label_edited`), so the issue is taken again. The labels decide only for an issue the hopper does not know, or a
// state the mirror does not judge.
//
// GitLab's ends put on what GitHub's do but in two cases, and those are told apart here, so the mirror never fights them: a
// GitLab job has no parts, and its finished report puts `hopper:pr-ready` on whether or not it found a merge request yet
// (`doneReported` `no_pr` and `part` read as `pr_open`); and a rejected job's report puts `hopper:rejected` on, which the
// dropped state's `dropReported` cannot tell from a cancel, so a drop by a job's end is not judged. Only the holder of the
// mirror's lease corrects and records (`mirrorHeld`). What the mirror saw is kept in memory only: an edit made while the
// hopper was stopped is not seen.
import type { IntakeContext } from '../domain/intake.ts';
import type { GitLabIssue } from '../domain/gitlab-account.ts';
import { ledgerReason } from '../sources/github/discover.ts';
import { handoffSettling, type DoneReport, type LabelFacts } from '../sources/github/item-labels.ts';
import { createLabelMirror } from '../sources/github/label-mirror.ts';
import type { GitHubOutbox } from '../sources/github/outbox.ts';

/** What a GitLab finished report put on: `hopper:pr-ready` while its issue is open, with or without a merge request. */
const gitlabDone = (r: DoneReport | undefined): DoneReport | undefined => (r === 'no_pr' || r === 'part' ? 'pr_open' : r);

const asListed = (i: GitLabIssue) => ({ url: i.url, repo: i.project, labels: i.labels });

export interface GitLabLedger {
  /** Find the end labels a person edited since the last discover, and record each: the issues whose edit is a Run again. */
  edits(issues: readonly GitLabIssue[]): Set<string>;
  /** The ledger's reason for the issue: `{}`, none (it may be taken); undefined, the ledger does not decide, so its labels do. */
  reason(i: GitLabIssue, edited: ReadonlySet<string>): { reason?: string } | undefined;
  /** Correct the labels of the issues listed that the discover does not take as a new job. */
  check(issues: readonly GitLabIssue[]): void;
}

/** The source's ledger reads and label mirror; undefined when the source has no work items (no ledger to read). */
export function gitlabLedger(o: { source: string; intake?: IntakeContext; outbox: GitHubOutbox; now(): Date }): GitLabLedger | undefined {
  const intake = o.intake, item = intake?.workItem;
  if (!intake || !item) return undefined;
  const judging = () => intake.mirrorHeld?.() !== false;
  const mirror = createLabelMirror({
    source: o.source, outbox: o.outbox, item, part: () => false, failureReported: (key) => intake.failureReported?.(key) ?? false, fixingReported: (key) => intake.fixingReported?.(key) ?? false,
    doneReported: (key) => gitlabDone(intake.doneReported?.(key)), now: () => o.now().toISOString(), log: (line) => console.warn(line), record: intake.record,
  });
  const facts = (key: string): LabelFacts => ({
    part: false, failureReported: (intake.failureReported?.(key) ?? false) && !handoffSettling(item(key), o.now().getTime()), fixingReported: intake.fixingReported?.(key) ?? false, doneReported: gitlabDone(intake.doneReported?.(key)),
  });
  return {
    edits: (issues) => mirror.edits(issues.map(asListed), judging()),
    reason: (i, edited) => (edited.has(i.url) ? {} : ledgerReason(item(i.url), facts(i.url))),
    check: (issues) => { if (judging()) mirror.check(issues.map(asListed)); },
  };
}
