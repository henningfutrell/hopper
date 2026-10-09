// The labels the hopper owns on an issue, with the colour/description it creates them with,
// and the one a person sets: `hopper:backburner` keeps an issue out (never picked up). After a job ends done (issue
// #579): `hopper:pr-ready` while its pull request waits for review, `hopper:partly-done` while the part it shipped waits,
// `hopper:pr-closed` once its pull request was closed without a merge; each keeps the issue out until it changes.
// An issue labelled `hopper@<name>` is addressed to the hopper of that name (issue #159).

export const LABEL_CLAIMED = 'hopper:claimed';
export const LABEL_DONE = 'hopper:done';
export const LABEL_FAILED = 'hopper:failed';
export const LABEL_BACKBURNER = 'hopper:backburner';
export const LABEL_REJECTED = 'hopper:rejected';
export const LABEL_PR_READY = 'hopper:pr-ready';
export const LABEL_PARTLY_DONE = 'hopper:partly-done';
export const LABEL_PR_CLOSED = 'hopper:pr-closed';
/** The labels a job's end leaves, any of which keeps the issue out; Run again takes them all off. */
export const END_LABELS: readonly string[] = [LABEL_FAILED, LABEL_DONE, LABEL_REJECTED, LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_PR_CLOSED];
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
];
