// The labels the hopper owns on an issue, with the colour/description it creates them with,
// and the one a person sets: `hopper:backburner` keeps an issue out (never picked up). After a job ends done (issue
// #579): `hopper:pr-ready` while its pull request waits for review, `hopper:partly-done` while the part it shipped waits,
// `hopper:pr-closed` once its pull request was closed without a merge, `hopper:blocked` when no pull request was found for
// it or its item is blocked (issue #1891; the label mirror, label-mirror.ts); each keeps the issue out until it changes.
// `hopper:needs-decision` while its job waits on a person's decision — a question, a proposal or a research report (issue
// #2693) —; the mirror puts it on and takes it off, and a person who takes it off asks for nothing.
// `hopper:needs-merge` in place of `hopper:pr-ready` or `hopper:partly-done` while its pull request is in a repository the
// hopper does not merge in (issue #2752): none of the job repositories, and no person named it on in yolo mode.
// An issue labelled `hopper@<name>` is addressed to the hopper of that name (issue #159). An issue labelled `hopper:win`
// (or `hopper:windows`) needs Windows: its job goes only to a Windows machine (issues #918, #1350, src/domain/windows-jobs.ts).

export const LABEL_CLAIMED = 'hopper:claimed';
export const LABEL_DONE = 'hopper:done';
export const LABEL_FAILED = 'hopper:failed';
export const LABEL_BACKBURNER = 'hopper:backburner';
export const LABEL_REJECTED = 'hopper:rejected';
export const LABEL_PR_READY = 'hopper:pr-ready';
export const LABEL_PARTLY_DONE = 'hopper:partly-done';
export const LABEL_PR_CLOSED = 'hopper:pr-closed';
export const LABEL_BLOCKED = 'hopper:blocked';
export const LABEL_NEEDS_DECISION = 'hopper:needs-decision';
export const LABEL_NEEDS_MERGE = 'hopper:needs-merge';
/** The labels a job's end leaves, any of which keeps the issue out; Run again takes them all off. */
export const END_LABELS: readonly string[] = [LABEL_FAILED, LABEL_DONE, LABEL_REJECTED, LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_BLOCKED, LABEL_NEEDS_DECISION, LABEL_NEEDS_MERGE];
/** `hopper@<name>`: the issue is for the hopper whose source has `hopperName: <name>`. */
export const ADDRESS_PREFIX = 'hopper@';
/**
 * `hopper:held-by:<id>`: who holds `hopper:claimed` (issue #440) — the claim holder id of one user of one hopper,
 * random, naming no person or machine. Written with the claim, removed with it.
 */
export const HOLDER_PREFIX = 'hopper:held-by:';
export const holderLabel = (holder: string): string => `${HOLDER_PREFIX}${holder}`;
export const HOLDER_LABEL_COLOR = 'ededed';
export const HOLDER_LABEL_DESCRIPTION = 'which hopper holds hopper:claimed';

export const HOPPER_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: LABEL_CLAIMED, color: 'fbca04', description: 'hopper is working on this' },
  { name: LABEL_DONE, color: '0e8a16', description: 'hopper finished this' },
  { name: LABEL_FAILED, color: 'd93f0b', description: 'hopper failed on this' },
  { name: LABEL_REJECTED, color: 'bfbfbf', description: 'hopper turned this away; remove to offer it again' },
  { name: LABEL_PR_READY, color: '0e8a16', description: 'hopper opened a pull request for this; it waits for review' },
  { name: LABEL_PARTLY_DONE, color: 'c2e0c6', description: 'hopper shipped part of this; the rest runs once that pull request merges' },
  { name: LABEL_PR_CLOSED, color: 'd93f0b', description: 'hopper\'s pull request was closed without a merge; remove to run it again' },
  { name: LABEL_BLOCKED, color: 'd93f0b', description: 'hopper is blocked on this and waits on a person; remove to run it again' },
  { name: LABEL_NEEDS_DECISION, color: '5319e7', description: 'hopper waits on a person\'s decision: a question, a proposal or a research report' },
  { name: LABEL_NEEDS_MERGE, color: 'fbca04', description: 'hopper\'s pull request waits on a person to merge it in a repository hopper does not merge in' },
];
