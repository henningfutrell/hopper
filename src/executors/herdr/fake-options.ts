// What the fake herdr client simulates (fake-client.ts): Claude's turns and startup dialogs, the pane's shell,
// and herdr's own ways. Test support only.
import type { Survey } from '../../domain/ports.ts';
import type { FakeTurn } from './fake-client.ts';

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
  /** Startup blocks on some other screen. */
  startupBlockedBy?: string[];
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
