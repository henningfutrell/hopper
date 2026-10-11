// Self-update (issue #44): what is installed, what is newer on the update channel, and how
// applying it stands. design.md "Self-update".

/**
 * The update channels, least stable first (issues #282, #423): each follows the branch of its name. Changes land on
 * `dev`, the default branch, are promoted to `beta`, then to `stable`.
 */
export const UPDATE_CHANNELS = ['dev', 'beta', 'stable'] as const;
/** What counts as newer: every commit on the channel's branch. */
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const isUpdateChannel = (name: string): name is UpdateChannel => (UPDATE_CHANNELS as readonly string[]).includes(name);

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
  /** The branch it was installed from: an update writes its channel's branch. */
  branch: string;
  commit: string;
  /** When it was built: the install, the update, or the image. */
  installedAt: string;
}

/**
 * `held` (issue #652): the channel has a newer commit, but it is not the merge of a pull request whose checks passed, or
 * GitHub could not say so. It is not offered, announced or applied; `reason` says why.
 */
export type UpdateState = 'unavailable' | 'current' | 'available' | 'held' | 'applying' | 'error';

/** The pull request a target is the merge of, whose checks passed (issue #652). */
export interface UpdatePullRequest { number: number; url: string }

/** What an update goes to: a commit of the channel's branch, and, when it is offered, its pull request. */
export interface UpdateTarget { commit: string; ref: string; pullRequest?: UpdatePullRequest }

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
  /** Apply an available update as soon as a check finds it. Always off for an image (issue #494): its user updates it. */
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
  /** Why updates are unavailable, why the target is held, or the last check's or apply's error. */
  reason?: string;
  installed?: InstallInfo;
  /** The newest commit of the channel: the head of its branch; `pullRequest` set when it is offered (issue #652). */
  target?: UpdateTarget;
  /** What's new: the target's WHATS-NEW.md bullets the installed version lacks, newest first, in plain words. */
  whatsNew: string[];
  /** What the installed version brought: the newest bullets of its own WHATS-NEW.md, update or not. */
  installedWhatsNew: string[];
  checkedAt?: string;
  apply?: UpdateApply;
  /** How many running jobs, of every user, a restart would lose now: what an apply waits on, and what recreating an image's container would end (issue #494). */
  restartBlockers: number;
}

/** The compose file a build ships with (issue #697): GET /api/update/compose. `compose` starts with the version stamp (`# hopper version: <branch> <commit>`). */
export interface ShippedCompose {
  branch?: string;
  commit?: string;
  compose: string;
}

/** One way the stack a container hopper runs in differs from the compose file of its version (issue #697). */
export interface StackGap {
  /** `service`: a service that must run does not; `setting`: the hopper's container lacks settings the file gives it; `version`: a service runs another version. */
  kind: 'service' | 'setting' | 'version';
  /** The service, or the settings, by name. */
  name: string;
  /** The gap, in words for a person. */
  what: string;
  /** What does not work until it is fixed. */
  off?: string;
}

/** GET /api/update/drift (issue #697): how the stack differs from the compose file of this version; one fix for every gap, the update script made from `image`. */
export interface StackDrift {
  /** `unchecked`: not a container install, or a build that ships no compose file (`reason`). */
  state: 'checked' | 'unchecked';
  reason?: string;
  gaps: StackGap[];
  /** The image the hopper runs, the update script is made from. */
  image?: string;
}
