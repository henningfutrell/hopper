// Self-update (issue #44): what is installed, what is newer on the update channel, and how
// applying it stands. design.md "Self-update".

export const UPDATE_CHANNELS = ['main', 'release'] as const;
/** What counts as newer: every commit on the tracked branch (`main`), or release tags only (`release`). */
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** `install.json` beside `src/`: what this install was built from. Written by scripts/install.sh and by an update. */
export interface InstallInfo {
  /** The git repository updates come from (the clone's `origin`). */
  repo: string;
  /** The tracked branch: the `main` channel follows its head. */
  branch: string;
  commit: string;
  installedAt: string;
}

export interface UpdateRelease {
  /** The newest `v<semver>` tag. */
  tag: string;
  commit: string;
  /** The installed commit does not contain it. */
  newer: boolean;
}

export type UpdateState = 'unavailable' | 'current' | 'available' | 'applying' | 'error';

export interface UpdateApply {
  /** `building` the new install beside the running one; `waiting` for running jobs a restart would lose; `restarting`. */
  phase: 'building' | 'waiting' | 'restarting';
  detail: string;
  /** The commit being applied. */
  target: string;
  startedAt: string;
}

export interface UpdateSettings {
  channel: UpdateChannel;
  /** Apply an available update as soon as a check finds it. */
  autoUpdate: boolean;
}

export interface UpdateStatus extends UpdateSettings {
  state: UpdateState;
  /** Why updates are unavailable, or the last check's or apply's error. */
  reason?: string;
  installed?: InstallInfo;
  /** The newest commit of the channel: the branch head (`main`) or the newest release's commit (`release`). */
  target?: { commit: string; ref: string };
  release?: UpdateRelease;
  /** What's new: the target's WHATS-NEW.md bullets the installed version lacks, newest first, in plain words. */
  whatsNew: string[];
  /** What the installed version brought: the newest bullets of its own WHATS-NEW.md, update or not. */
  installedWhatsNew: string[];
  checkedAt?: string;
  apply?: UpdateApply;
}
