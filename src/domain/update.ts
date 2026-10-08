// Self-update (issue #44): what is installed, what is newer on the update channel, and how
// applying it stands. design.md "Self-update".

/** The channels that follow a branch of the same name, least stable first (issue #282): changes land on `dev`, are promoted to `beta`, then to `main`. */
export const BRANCH_CHANNELS = ['dev', 'beta', 'main'] as const;
export const UPDATE_CHANNELS = [...BRANCH_CHANNELS, 'release'] as const;
/** What counts as newer: every commit on the channel's branch (`dev`, `beta`, `main`), or release tags only (`release`). */
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export type BranchChannel = (typeof BRANCH_CHANNELS)[number];

export const isBranchChannel = (name: string): name is BranchChannel => (BRANCH_CHANNELS as readonly string[]).includes(name);

/**
 * How a build of the hopper is replaced (issue #409): `install` — a directory built by scripts/install.sh or an
 * update, which self-update swaps in place; `image` — baked into a container image at build time, replaced by
 * pulling or rebuilding the image, never by self-update.
 */
export type InstallKind = 'install' | 'image';

/** `install.json` beside `src/`: what this build was made from. Written by scripts/install.sh, by an update, and by the image build. */
export interface InstallInfo {
  kind: InstallKind;
  /** The git repository updates come from (the clone's `origin`). */
  repo: string;
  /** The branch it was installed from: an update on a branch channel writes that channel's branch. */
  branch: string;
  commit: string;
  /** When it was built: the install, the update, or the image. */
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

/** One version in the version history: a commit of the tracked branch that brought What's new lines. */
export interface VersionEntry {
  commit: string;
  /** When it landed on the tracked branch (its commit date). */
  at: string;
  /** The What's new lines it added, in plain words, newest first. */
  changes: string[];
}

/** The version history (issue #246): the versions the installed commit is made of, newest first. */
export interface VersionHistory {
  versions: VersionEntry[];
  /** What the running build knows of where it came from, whole or not (issue #409): install.json's fields that are there. */
  build: Partial<InstallInfo>;
  /** Why there is none: no install.json, a field it lacks, or the update repository cannot be read. */
  reason?: string;
}

export interface UpdateStatus extends UpdateSettings {
  state: UpdateState;
  /** Why updates are unavailable, or the last check's or apply's error. */
  reason?: string;
  installed?: InstallInfo;
  /** The newest commit of the channel: its branch head (`dev`, `beta`, `main`) or the newest release's commit (`release`). */
  target?: { commit: string; ref: string };
  release?: UpdateRelease;
  /** What's new: the target's WHATS-NEW.md bullets the installed version lacks, newest first, in plain words. */
  whatsNew: string[];
  /** What the installed version brought: the newest bullets of its own WHATS-NEW.md, update or not. */
  installedWhatsNew: string[];
  checkedAt?: string;
  apply?: UpdateApply;
}
