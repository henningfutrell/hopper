// The labels the hopper owns on an issue, with the colour/description it creates them with,
// and the ones a person sets: `hopper:backburner` keeps an issue out (never picked up);
// `hopper:complete-at-merge` / `hopper:complete-at-pr` set the issue's completion (issue #187).
// An issue labelled `hopper@<name>` is addressed to the hopper of that name (issue #159).

export const LABEL_CLAIMED = 'hopper:claimed';
export const LABEL_DONE = 'hopper:done';
export const LABEL_FAILED = 'hopper:failed';
export const LABEL_BACKBURNER = 'hopper:backburner';
export const LABEL_COMPLETE_AT_MERGE = 'hopper:complete-at-merge';
export const LABEL_COMPLETE_AT_PR = 'hopper:complete-at-pr';
export const LABEL_REJECTED = 'hopper:rejected';
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
];
