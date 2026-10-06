// The labels the hopper owns on an issue, with the colour/description it creates them with,
// and the ones a person sets: `hopper:backburner` parks an issue (never picked up);
// `hopper:complete-at-merge` / `hopper:complete-at-pr` set the issue's completion (issue #187).

export const LABEL_CLAIMED = 'hopper:claimed';
export const LABEL_DONE = 'hopper:done';
export const LABEL_FAILED = 'hopper:failed';
export const LABEL_BACKBURNER = 'hopper:backburner';
export const LABEL_COMPLETE_AT_MERGE = 'hopper:complete-at-merge';
export const LABEL_COMPLETE_AT_PR = 'hopper:complete-at-pr';

export const HOPPER_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: LABEL_CLAIMED, color: 'fbca04', description: 'hopper is working on this' },
  { name: LABEL_DONE, color: '0e8a16', description: 'hopper finished this' },
  { name: LABEL_FAILED, color: 'd93f0b', description: 'hopper failed on this' },
];
