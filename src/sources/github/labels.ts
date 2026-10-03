// The labels the hopper owns on an issue, with the colour/description it creates them with.

export const LABEL_CLAIMED = 'hopper:claimed';
export const LABEL_DONE = 'hopper:done';
export const LABEL_FAILED = 'hopper:failed';

export const HOPPER_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: LABEL_CLAIMED, color: 'fbca04', description: 'job-hopper is working on this' },
  { name: LABEL_DONE, color: '0e8a16', description: 'job-hopper finished this' },
  { name: LABEL_FAILED, color: 'd93f0b', description: 'job-hopper failed on this' },
];
