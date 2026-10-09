// What the fake herdr client simulates (fake-client.ts): Claude's turns and startup dialogs, the pane's shell,
// and herdr's own ways, and what a test reads and drives of it. Test support only.
import type { Survey } from '../../domain/ports.ts';
import type { DiscoveryFacts } from '../../domain/types.ts';
import type { HerdrClient } from './client.ts';

/** One scripted turn of Claude's: what it shows while working and when it ends, and how it ends. */
export interface FakeTurn {
  /** Lines appended while working, one per poll. */
  steps?: string[];
  /** Lines appended when the turn ends (assistant output, markers). */
  output: string[];
  /** State after the turn. Default `idle`. `exit`: Claude quits. `working`: never ends. */
  end?: 'idle' | 'blocked' | 'exit' | 'working';
  /** With `end: 'blocked'`: the dialog, shown below the output until it is answered or lapses, then gone, as Claude Code does. */
  dialog?: string[];
  /**
   * Claude Code's transcript stays scrolled up (seen live after a long prompt): the output is
   * hidden behind "N new message (ctrl+End) ↓" until Ctrl+End (ESC [1;5F) is sent as text.
   */
  hiddenUntilScrolled?: boolean;
  /**
   * The turn started background work (issue #491): the footer names `work` for `polls` polls after the turn
   * ends. Then the work ends and, as Claude Code's notification does, Claude goes on with the next scripted
   * turn by itself, unless `wakes` is false.
   */
  background?: { work: string; polls: number; wakes?: boolean };
}

export interface FakeHerdrOptions {
  turns?: FakeTurn[];
  /** Startup blocks on the folder-trust dialog naming this path. */
  trustDialogFor?: string;
  /**
   * Startup shows Claude's bypass permissions warning (after the trust dialog, when both): herdr's agent
   * start answers `notReady` at it, or (`started`) reports Claude started while the warning is up.
   */
  bypassDialog?: 'not-ready' | 'started';
  /**
   * Startup asks whether a CLAUDE.md may import files outside the cwd (issue #518): the work tree's CLAUDE.md
   * importing a file of the work tree, seen from a job worktree inside it. After the trust dialog, before the
   * bypass permissions warning. Either answer goes on to the next.
   */
  importsDialog?: string;
  /** Startup blocks on some other screen. Its option picked by number, Claude comes up; esc leaves it up. */
  startupBlockedBy?: string[];
  /**
   * Claude comes up ready, then, `after` looks later, shows `lines`, a dialog of its own, and blocks there (issue #534,
   * seen live just after the trust dialog was answered): before the hopper sent anything. Its option picked by number,
   * Claude is ready again; esc leaves it up, and herdr refuses a prompt while it is.
   */
  lateDialog?: { lines: string[]; after: number };
  /**
   * Claude's config in the home of the pane's machine (issue #533): `absent` until the hopper's seed writes it (shared
   * by every pane, as a home is), `present` (default) the user's, which the seed keeps, or `unwritable`.
   */
  claudeConfig?: 'absent' | 'present' | 'unwritable';
  /** The first-run screens Claude shows, in order, while its home has no config; before the trust dialog. Default theme, then login. */
  firstRun?: ('theme' | 'login' | 'apiKey' | 'notice')[];
  /** Claude has no credential on the machine: its prompt shows "Not logged in · Run /login" until `signIn()` (issue #533). */
  notSignedIn?: boolean;
  /** herdr's agent start answers ok and calls Claude idle at its startup screens, as seen live at the first-run theme picker (issue #533). */
  idleAtStartupScreens?: boolean;
  /**
   * Before Claude draws anything, the pane shows `lines` — its launch line echoed (a Windows shell's
   * `-EncodedCommand`), or a setup command still on screen (issue #527) — and herdr calls the agent blocked, for
   * `polls` looks at it (Infinity: Claude never comes up); then Claude starts. `started`: herdr's agent start
   * answered ok all the same, else `notReady`.
   */
  startupEcho?: { lines: string[]; polls: number; started?: boolean };
  /** The first N `runInPane` commands are lost, as a shell not at its prompt yet drops what is typed. */
  shellDropsRuns?: number;
  /** The first N job worktree commands are lost (issue #518, seen live in a zsh whose start-up files were busy). */
  dropsWorktreeRuns?: number;
  /** The job worktree command prints its outcome only after this many waits on the pane (a slow fetch or clone). */
  worktreeLag?: number;
  /**
   * herdr's wait-output answers at once, whatever the pane shows (issue #518, seen live on two machines): `matched`
   * as though the text were there, `timeout` as though its time had passed.
   */
  waitAnswersEarly?: 'matched' | 'timeout';
  /** What the reap at job end says it kept (issue #401): repositories with uncommitted or unpushed work. Default none. */
  reapKeeps?: string[];
  /** The machine cannot be reached for the reap or the survey (issue #410): both reject. */
  machineUnreachable?: boolean;
  /** What the survey finds on the machine (issue #410). Default nothing. */
  survey?: Survey;
  /** What a discovery finds on the machine (issue #542). Default nothing. */
  discovery?: DiscoveryFacts;
  /** The machine runs a systemd user manager: the pane's shell enters the job's scope (issue #410). Default no systemd. */
  scopes?: boolean;
  /** Claude stays up through ctrl+c, so it never exits before its pane closes. */
  ignoresCtrlC?: boolean;
  /** Directories the pane's shell cannot enter on this machine: a `cd` into one fails, as for a path that is not there (issue #323). */
  unusableDirs?: string[];
  /** The pane's shell is a Windows shell, not a POSIX one (issue #367): it answers every command with its own error and prompt. */
  windowsShell?: 'powershell' | 'cmd';
  /** Work trees that are the top of a git repository: a job worktree command there makes one (issue #379). */
  repositories?: string[];
  /** Git refuses to make a job worktree. */
  worktreeFails?: boolean;
  /** What sharing dependencies in a job worktree says (issue #410). Default `none`: no lockfile. */
  deps?: 'linked' | 'installed' | 'own' | 'kept' | 'none' | 'failed';
  /** The first N `startAgent` calls answer `paneBusy`, as herdr does for a pane spawned a moment ago. */
  shellNotReadyStarts?: number;
  /**
   * The first N agent starts time out (issue #462, seen live with 16 lanes filling at once): Claude never
   * comes up as herdr waits, and `agent start` fails `timeout`, "timed out waiting for agent startup", with
   * `startupTimeoutScreen` on the pane.
   */
  startupTimeouts?: number;
  /** What the pane shows when its agent start times out. */
  startupTimeoutScreen?: string[];
  /**
   * The first N prompts never reach Claude (issue #278, seen live): herdr takes them, but Claude stays
   * idle at an empty prompt, nothing echoed and its state never changes.
   */
  dropsPrompts?: number;
  /**
   * The first N prompts are pasted into Claude's input box but never submitted (seen live): the box
   * shows "[Pasted text #1 +N lines]", Claude stays idle and its state never changes, until Enter.
   */
  promptsLeftInInput?: number;
  /** The first N option picks at a dialog are lost: Claude stays at the dialog, its state unchanged. */
  dropsDialogPicks?: number;
  session?: string;
  /** Column width the prompt echo is wrapped at. Default 100. */
  width?: number;
}

export interface FakeHerdrClient extends HerdrClient {
  readonly calls: { method: string; args: unknown[] }[];
  readonly prompts: { name: string; text: string }[];
  readonly keys: { paneId: string; keys: string[] }[];
  readonly texts: { paneId: string; text: string }[];
  readonly closed: string[];
  readonly agentStarts: { name: string; paneId: string; args: string[]; timeoutMs: number }[];
  /** Each seed of Claude's config the shell ran (issue #533): its arguments, the work tree, trust and yolo. */
  readonly seeds: string[][];
  /** Each reap through the machine's connection (issue #410): the job and its scratch dir. */
  readonly reaps: { jobId: string; scratch?: string }[];
  /** Each credential file kept on the machine through its connection (issue #441), in order. */
  readonly credentials: { jobId: string; dir: string; file: string; content: string; make?: boolean }[];
  addTurns(...turns: FakeTurn[]): void;
  /** Claude is signed in on the machine from now on (`notSignedIn`). */
  signIn(): void;
  /** The next N prompts never reach Claude, as `dropsPrompts`. */
  dropPrompts(n: number): void;
  /** Claude denies its dialog by itself, its countdown run out (issue #376): it goes on with the next scripted turn, nothing typed. */
  lapseDialog(name: string): void;
  /** Claude disappears from its pane (crashed, closed by hand). */
  killAgent(name: string): void;
  /** Claude goes on with the next scripted turn by itself, nothing sent: a background notification, or a person typing in its pane. */
  wake(name: string): void;
  /** The next call of `method` rejects with a HerdrError of this code. */
  failNext(method: keyof HerdrClient, code: string): void;
  /** While set, every call rejects as a client target not dialled in does (issue #371): the panes live on, unreached. */
  setUnreachable(on: boolean): void;
  screen(paneId: string): string;
}
