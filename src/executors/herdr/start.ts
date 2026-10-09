// Opening a job's pane and getting Claude ready in it: workspace, tab, agent start, and the
// startup dialogs (folder trust; external CLAUDE.md imports in a trusted work tree; the bypass permissions
// warning when yolo). docs/design.md "Phase 2" → "Start".

import { randomUUID } from 'node:crypto';
import type { Clock, ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import { HerdrError, type HerdrClient } from './client.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { abortReason, tail } from './monitor.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { JOB_WORKTREE_MARK, JOB_WORKTREE_RUNNING, checkoutOf, checkoutWorktreeOf, jobWorktreeOf, jobWorktreeOutcome, makeJobWorktreeCommand } from './job-worktree.ts';
import { SCOPE_MARK, enterScopeCommand, scopeCheckCommand, scopeOutcome } from './job-scope.ts';
import { DEPS_MARK, depsOutcome, shareDepsCommand } from './shared-deps.ts';
import { scopeUnitOf } from '../../client/server.ts';
import { SCRATCH_DIR, isBypassDialog, isImportsDialog, isTrustDialog, showsDialog, windowsShellOf } from './screen.ts';
import { shellQuote } from '../ssh.ts';

export const WORKSPACE_LABEL = 'hopper';
const START_TIMEOUT_MS = 60000;
/** How long Claude has to come up once started, its startup dialogs answered (issue #527: a Windows machine's PowerShell launch is slow). */
const SETTLE_TIMEOUT_MS = 2 * START_TIMEOUT_MS;
const SHELL_RETRY_MS = 100;
/** What the scratch command prints last, so the hopper knows the shell ran it. */
export const SCRATCH_READY = 'hopper-scratch-ready';
/** What it prints instead when the shell cannot enter the work tree or make the scratch dir (issue #323). */
export const SCRATCH_UNUSABLE = 'hopper-scratch-unusable';
const SCRATCH_WAIT_MS = 1000;
/** How long the job worktree command may take: it fetches first (issue #379), or clones the job's repository (issue #361). */
const JOB_WORKTREE_WAIT_MS = 10 * 60000;
/** How long the shell has to start the job worktree command, and how often it is typed, before the start is tried again (issue #518). */
const JOB_WORKTREE_RUNNING_WAIT_MS = 10000;
const JOB_WORKTREE_TYPINGS = 3;
/** How long sharing dependencies may take: the first job with a lockfile installs them (issue #410). */
const DEPS_WAIT_MS = 15 * 60000;
/** A machine's scratch age when it sets none: an entry of shared dependencies nothing links to goes after it. */
const SCRATCH_MAX_AGE_HOURS = 24;
/** Startup dialogs answered at most: folder trust, external imports and the bypass permissions warning, with room to spare. */
const MAX_STARTUP_DIALOGS = 4;

/** What grants Claude every permission: the flag, and the permission mode that means the same. */
const YOLO_FLAG = '--dangerously-skip-permissions';
const GRANTS_ALL = new Set([YOLO_FLAG, '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions']);
/** Claude's own setting that the bypass permissions warning was accepted, given on the command line. */
export const YOLO_SETTINGS = JSON.stringify({ skipDangerousModePermissionPrompt: true });

/**
 * The arguments Claude starts with (issue #267, design.md "Yolo"): the instance's `yolo` decides
 * whether Claude has every permission, never its `args`. Yolo puts the flag first, with the setting that
 * its warning was accepted unless the args name settings of their own; not yolo drops every argument
 * that would grant it, so Claude asks and the hopper takes each dialog to the job's answerers.
 */
export function claudeArgsFor(yolo: boolean, args: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (GRANTS_ALL.has(args[i]!)) continue;
    if (args[i] === '--permission-mode' && args[i + 1] === 'bypassPermissions') { i++; continue; }
    rest.push(args[i]!);
  }
  if (!yolo) return rest;
  const named = rest.some((a) => a === '--settings' || a.startsWith('--settings='));
  return [YOLO_FLAG, ...(named ? [] : ['--settings', YOLO_SETTINGS]), ...rest];
}

/** What a job keeps in `job.executorState`. */
export interface PaneState {
  session?: string;
  /** The attached machine's ssh destination; absent → this machine's herdr. */
  ssh?: string;
  /** A client target's: which machine (design.md "Client targets"). */
  client?: { machine: string };
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  cwd: string;
  /** The job's own git worktree of `cwd` or of `checkout`, in its scratch dir, where Claude runs (issue #379). Absent: Claude runs in `cwd`. */
  jobWorktree?: string;
  /** The checkout of the job's repository in `cwd` its worktree was made of, when `cwd` is no repository (issue #361). */
  checkout?: string;
  /** The systemd user scope the pane's shell runs in (issue #410). Absent: the machine has none; the reap goes by HOPPER_JOB_ID. */
  scope?: string;
  /** The job worktree's node_modules links to dependencies shared with the repository's other jobs (issue #410). */
  sharedDependencies?: boolean;
  laneId: string;
  /** The turn in flight, recorded at every send, so a restarted daemon can watch it again. */
  turn?: TurnAnchor;
  /**
   * state_change_seq when the turn stopped on a question: Claude moving past it means the owner answered in the pane.
   * Named before parked jobs (issue #501), which it has nothing to do with; kept, as jobs on a question hold it.
   */
  parkedSeq?: number;
  /** The waiting turn waits at a dialog Claude Code denies by itself at this time (issue #376). */
  lapsesAt?: string;
  /** The login the turn waits on (issue #476): Claude going on by itself completes it. */
  login?: { id: string; tool: string };
}

/** What the monitor needs to find one turn's outcome: design.md "Turn anchor (B1)". */
export interface TurnAnchor {
  /** state_change_seq read just before the send. */
  seq: number;
  /** Last line of what was sent, as Claude echoes it. */
  anchor: string;
  /** Claude was at a dialog when we sent. */
  blockedAtSend: boolean;
  /** What was sent, to send again when it never reached Claude (issue #278). Absent in turns saved before. */
  text?: string;
  /**
   * Nothing of it reached Claude (issue #534): Claude stood at a dialog before `text` was sent, and the job asked the
   * dialog as its question. `text` is sent once the dialog is answered.
   */
  unsent?: true;
}

export interface StartDeps {
  herdr: HerdrClient;
  clock: Clock;
  sleep: Sleep;
  pollMs: number;
  claudeArgs: string[];
  trustWorkdir: boolean;
  /** Claude starts with every permission granted: its warning about that is accepted at startup. */
  yolo: boolean;
  /** A work tree that is the top of a git repository gets each job its own worktree of it (issue #379). */
  jobWorktrees: boolean;
  /** A job worktree's node_modules is linked to dependencies shared with the repository's other jobs (issue #410). */
  sharedDependencies: boolean;
  /** A new agent session id (issue #501); default a random UUID, as Claude's `--session-id` takes. */
  newSession?: () => string;
}

/**
 * A start that did not finish in time (issue #462): the pane's shell or Claude never came up. Nothing of
 * the job has run yet, so the executor may try it again in a new pane. `error` carries the pane's last output.
 */
export interface StartTimedOut { startTimedOut: string }

export const agentNameFor = (jobId: string): string => `jh-${jobId.slice(0, 8)}`;

/** The work tree's scratch dirs, git-ignored as one (design.md "Work tree"). */
export const scratchDirOf = (cwd: string): string => `${cwd.replace(/\/+$/, '')}/${SCRATCH_DIR}`;

/**
 * The job's own scratch dir: Claude's scratchpad, every temp file, and the clones it makes only for this
 * job. Its own, so the reap can remove it when the job ends (issue #401, reap.ts).
 */
export const jobScratchOf = (cwd: string, jobId: string): string => `${scratchDirOf(cwd)}/${jobId}`;

/**
 * The job's temp link (issue #506), its TMPDIR: a short link to its scratch dir. A Unix socket path takes at most 108
 * bytes, and a tool binds its sockets under TMPDIR (Chromium's `org.chromium.Chromium.XXXXXX/SingletonSocket`
 * alone takes 45), so the scratch dir's own path left too little room. What is written through it lands in
 * the scratch dir all the same; the reap removes the link.
 */
export const jobTmpOf = (jobId: string): string => `/tmp/hopper-${jobId}`;

/** Points the job's temp link at its scratch dir; fails when the link there is not that. */
export const linkTmpCommand = (scratch: string, jobId: string): string => {
  const link = shellQuote(jobTmpOf(jobId));
  return `ln -sfn ${shellQuote(scratch)} ${link} && [ "$(readlink ${link})" = ${shellQuote(scratch)} ]`;
};

/** Makes the job's scratch dir, git-ignored, and its temp link; prints the ready or unusable marker. */
export const scratchCommand = (cwd: string, jobId: string, make: boolean): string => {
  const scratch = jobScratchOf(cwd, jobId);
  return `${make ? `mkdir -p ${shellQuote(cwd)} && ` : ''}cd ${shellQuote(cwd)} && mkdir -p ${shellQuote(scratch)} && printf '*\\n' > ${shellQuote(`${scratchDirOf(cwd)}/.gitignore`)}`
    + ` && ${linkTmpCommand(scratch, jobId)} && printf 'hopper-scratch-%s\\n' ready || printf 'hopper-scratch-%s\\n' unusable`;
};

/**
 * Create the tab and record it at once, before anything can fail in it. The tab's environment
 * points Claude's scratchpad and every temp file at the scratch dir.
 */
export async function openPane(d: StartDeps, ctx: ExecutionContext, cwd: string, env: Record<string, string>): Promise<PaneState> {
  const tmp = jobTmpOf(ctx.job.id);
  const workspaceId = await d.herdr.ensureWorkspace(WORKSPACE_LABEL, cwd);
  const { tabId, paneId } = await d.herdr.createTab({
    workspaceId, cwd, label: `${ctx.laneId} · ${ctx.job.id.slice(0, 8)}`,
    // HOPPER_JOB_ID and the scratch dir come from the hopper; a payload cannot move them. Claude Code's
    // countdown that denies a dangerous rm by itself is off (issue #376): the question climbs to the owner,
    // which takes longer than its two minutes.
    env: { ...env, CLAUDE_CODE_TMPDIR: tmp, TMPDIR: tmp, HOPPER_JOB_ID: ctx.job.id, CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '1' },
  });
  const state: PaneState = {
    ...(d.herdr.session ? { session: d.herdr.session } : {}),
    ...(ctx.machine.ssh && ctx.machine.herdr ? { ssh: ctx.machine.ssh } : {}),
    ...(ctx.machine.client ? { client: { machine: ctx.machine.id } } : {}),
    workspaceId, tabId, paneId, agentName: agentNameFor(ctx.job.id), cwd, laneId: ctx.laneId,
  };
  ctx.saveState({ ...state });
  return state;
}

/**
 * What the hopper answers to the startup dialog on `screen`, as the progress it reports, or undefined when it may not
 * answer it: the folder trust of `dir` and the external imports (with `trustWorkdir`), the bypass warning (with yolo).
 */
export function startupAnswer(d: Pick<StartDeps, 'trustWorkdir' | 'yolo'>, screen: string, dir: string): string | undefined {
  return d.trustWorkdir && isTrustDialog(screen, dir) ? `trusted workdir ${dir}`
    : d.trustWorkdir && isImportsDialog(screen) ? 'allowed the external CLAUDE.md imports of the trusted work tree'
      : d.yolo && isBypassDialog(screen) ? 'accepted bypass permissions mode' : undefined;
}

/**
 * Wait until Claude is ready for the prompt, answering the startup dialogs the hopper may answer: the
 * folder-trust dialog naming the job's cwd and the external CLAUDE.md imports dialog (issue #518; both when
 * `trustWorkdir`: the work tree is trusted, the CLAUDE.md that imports is its own or above it), and the
 * bypass permissions warning (when yolo). Any other dialog Claude shows, it is up all the same: the send finds it and asks it
 * of a person (issue #534). A dialog is judged
 * once per state change, so keys sent to one never land on the next. `started`: herdr's agent start found Claude
 * ready, so anything but a dialog is; else herdr found it held at one. A screen that shows no dialog is not one
 * (issue #527): what stood on the pane before Claude drew — its launch line echoed (a Windows shell's
 * `-EncodedCommand`), a setup command — is looked at again until Claude is up, or the start times out, to be
 * tried again in a new pane. Null when up (or aborted), else the failure or the start that timed out.
 */
async function settleStartup(d: StartDeps, ctx: ExecutionContext, s: PaneState, started: boolean): Promise<ExecutionOutcome | StartTimedOut | null> {
  const until = d.clock.now().getTime() + SETTLE_TIMEOUT_MS;
  let answeredAt = -1;
  let answered = 0;
  while (d.clock.now().getTime() < until) {
    if (ctx.signal.aborted) return null;
    const agent = await d.herdr.getAgent(s.agentName);
    if (!agent) return { kind: 'failed', error: 'claude exited at startup' };
    if (agent.status === 'idle' || agent.status === 'done' || (started && answered === 0 && agent.status !== 'blocked')) return null;
    if ((agent.status === 'blocked' || (!started && answered === 0)) && agent.stateChangeSeq !== answeredAt) {
      const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
      const dialog = startupAnswer(d, screen, s.jobWorktree ?? s.cwd);
      if (dialog && answered < MAX_STARTUP_DIALOGS) {
        // Each dialog opens on its refusing option; the next one down accepts.
        await d.herdr.sendKeys(s.paneId, ['down', 'enter']);
        ctx.progress(0, dialog);
        answeredAt = agent.stateChangeSeq;
        answered++;
        continue;
      }
      // Claude is up, at a dialog the hopper may not answer: the send asks it of a person (issue #534, before-send.ts).
      if (dialog || showsDialog(screen)) return null;
    }
    await d.sleep(d.pollMs, ctx.signal);
  }
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  return { startTimedOut: `claude not ready at startup: ${tail(screen, 30)}` };
}

/**
 * What `parse` reads on the pane once it shows, waiting up to `ms` by the hopper's own clock (issue #518): herdr's
 * wait-output on some machines answered within seconds, the text not there yet, so its answer only says when to
 * look at the screen, never what is on it. Undefined when `ms` passed (or the signal fired) first, with the screen.
 */
async function awaitOnScreen<T>(d: StartDeps, ctx: ExecutionContext, paneId: string, mark: string, parse: (screen: string) => T | undefined, ms: number): Promise<{ found?: T; screen: string }> {
  const until = d.clock.now().getTime() + ms;
  for (;;) {
    await d.herdr.waitOutput(paneId, mark, Math.max(1, until - d.clock.now().getTime()));
    const screen = await d.herdr.read(paneId, { source: 'recent-unwrapped', lines: 40 });
    const found = parse(screen);
    if (found !== undefined) return { found, screen };
    if (ctx.signal.aborted || d.clock.now().getTime() >= until) return { screen };
    await d.sleep(d.pollMs, ctx.signal);
  }
}

/** Whether a line of the screen is `line`. */
const shows = (line: string) => (screen: string): true | undefined => (screen.split('\n').some((l) => l.trim() === line) ? true : undefined);

/**
 * Make the scratch dir in the pane's own shell, so on whichever machine the work tree is; its
 * `.gitignore` hides it from git. The shell enters the work tree first: herdr opens a tab whose cwd
 * does not exist there in the home instead, so only the shell can say the work tree is not usable,
 * and then the job fails at once with what it said (issue #323). The jobs directory, and a work tree
 * under it, the shell makes first (`make`, issue #314). A fresh shell drops what is typed before its
 * prompt, so the command runs again until its output shows. The command is POSIX shell: a pane whose
 * shell is PowerShell or cmd fails the job at once, naming it (issue #367). Null when made, else the failure.
 */
async function makeScratch(d: StartDeps, ctx: ExecutionContext, s: PaneState, make: boolean): Promise<ExecutionOutcome | StartTimedOut | null> {
  const command = scratchCommand(s.cwd, ctx.job.id, make);
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += SCRATCH_WAIT_MS) {
    if (ctx.signal.aborted) return null;
    await d.herdr.runInPane(s.paneId, command);
    await d.herdr.waitOutput(s.paneId, SCRATCH_READY, SCRATCH_WAIT_MS);
    // herdr's answer is not taken for the screen (issue #518): the line itself shows it ran.
    const screen = await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: 40 });
    if (shows(SCRATCH_READY)(screen)) return null;
    if (shows(SCRATCH_UNUSABLE)(screen)) {
      return { kind: 'failed', error: `the work tree ${s.cwd} is not usable on ${ctx.machine.id}: ${tail(screen, 10)}` };
    }
    const shell = windowsShellOf(screen);
    if (shell) {
      return { kind: 'failed', error: `the shell of pane ${s.paneId} on ${ctx.machine.id} is ${shell}, and the hopper needs a POSIX shell (sh, bash, zsh) there: make one herdr's default shell for the hopper's herdr session on that machine (README "A Windows computer")` };
    }
  }
  return { startTimedOut: `pane ${s.paneId} never ran the scratch dir command within ${START_TIMEOUT_MS} ms` };
}

/**
 * Move the pane's shell into the job's own systemd user scope (issue #410, job-scope.ts), when the machine
 * has a user manager: everything the job starts is then in it, and the reap stops it. The shell is replaced
 * by a new one, which drops what is typed before its prompt, so the check runs again until it answers.
 * A machine without systemd, or a shell that did not land in the scope, goes on without one. Null when
 * done, else the failure (the shell never answered: the pane is gone or hung).
 */
async function enterScope(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<StartTimedOut | null> {
  await d.herdr.runInPane(s.paneId, enterScopeCommand(ctx.job.id));
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += SCRATCH_WAIT_MS) {
    if (ctx.signal.aborted) return null;
    if (await d.herdr.waitOutput(s.paneId, SCOPE_MARK, SCRATCH_WAIT_MS)) {
      const outcome = scopeOutcome(await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: 40 }));
      if (outcome === 'entered') {
        s.scope = scopeUnitOf(ctx.job.id);
        ctx.saveState({ ...s });
        return null;
      }
      if (outcome) return null;
    }
    await d.herdr.runInPane(s.paneId, scopeCheckCommand(ctx.job.id));
  }
  return { startTimedOut: `pane ${s.paneId} never answered where its shell runs within ${START_TIMEOUT_MS} ms` };
}

/**
 * Make the job its own git worktree and move the pane's shell into it (issues #379, #361): of the work
 * tree when that is the top of a git repository; else of the checkout of the job's repository in it,
 * fetched or cloned there first. `s` then names it, saved, and it is reported as the job's work tree.
 * With job worktrees off, only the checkout is made, and the job runs in the work tree. Git refusing fails
 * the job with what it said. The command says first that it runs: a shell that lost or mangled it (issue
 * #518, a zsh whose start-up files were busy) gets the line cleared and the command typed again, and one
 * that never runs it times the start out, to be tried again in a new pane. A run again finds the worktree
 * the first one made and enters it.
 */
async function enterJobWorktree(d: StartDeps, ctx: ExecutionContext, s: PaneState, repo: string | undefined): Promise<ExecutionOutcome | StartTimedOut | null> {
  if (repo) ctx.progress(0, `fetching or cloning ${repo} in the work tree`);
  const command = makeJobWorktreeCommand(s.cwd, ctx.job.id, { ...(repo ? { repo } : {}), worktrees: d.jobWorktrees });
  for (let typed = 1; ; typed++) {
    await d.herdr.runInPane(s.paneId, command);
    const running = await awaitOnScreen(d, ctx, s.paneId, JOB_WORKTREE_RUNNING, shows(JOB_WORKTREE_RUNNING), JOB_WORKTREE_RUNNING_WAIT_MS);
    if (running.found || ctx.signal.aborted) break;
    if (typed >= JOB_WORKTREE_TYPINGS) {
      return { startTimedOut: `pane ${s.paneId} never ran the job worktree command (typed ${typed} times): ${tail(running.screen, 10)}` };
    }
    ctx.progress(0, `the shell did not run the job worktree command; typing it again (${typed + 1} of ${JOB_WORKTREE_TYPINGS})`);
    await d.herdr.sendKeys(s.paneId, ['ctrl+c']);
  }
  if (ctx.signal.aborted) return null;
  const { found: outcome, screen } = await awaitOnScreen(d, ctx, s.paneId, JOB_WORKTREE_MARK, jobWorktreeOutcome, JOB_WORKTREE_WAIT_MS);
  if (outcome === 'none' || ctx.signal.aborted) return null;
  const path = outcome === 'checkout' && repo ? checkoutWorktreeOf(s.cwd, ctx.job.id, repo) : jobWorktreeOf(s.cwd, ctx.job.id);
  if (outcome !== 'made' && outcome !== 'checkout') {
    return { kind: 'failed', error: outcome === 'unmade' ? `the job worktree ${path} could not be made on ${ctx.machine.id}: ${tail(screen, 10)}`
      : `pane ${s.paneId} never made the job worktree within ${JOB_WORKTREE_WAIT_MS} ms: ${tail(screen, 10)}` };
  }
  s.jobWorktree = path;
  if (outcome === 'checkout' && repo) s.checkout = checkoutOf(s.cwd, repo);
  ctx.saveState({ ...s });
  ctx.workTree(path);
  return null;
}

/**
 * Link the job worktree's node_modules to the dependencies its lockfile shares with the repository's other
 * jobs, installing them first when no job has (issue #410, shared-deps.ts). Whatever it says, the job goes
 * on: a failed install is the job's to redo. Only a shell that never answers fails it.
 */
async function shareDependencies(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<ExecutionOutcome | null> {
  ctx.progress(0, 'sharing dependencies with the repository\'s other jobs');
  await d.herdr.runInPane(s.paneId, shareDepsCommand(s.cwd, s.jobWorktree!, ctx.machine.sweep?.scratchMaxAgeHours ?? SCRATCH_MAX_AGE_HOURS));
  const { found: outcome, screen } = await awaitOnScreen(d, ctx, s.paneId, DEPS_MARK, depsOutcome, DEPS_WAIT_MS);
  if (ctx.signal.aborted) return null;
  if (!outcome) return { kind: 'failed', error: `pane ${s.paneId} never shared dependencies within ${DEPS_WAIT_MS} ms: ${tail(screen, 10)}` };
  if (outcome === 'linked' || outcome === 'installed') {
    s.sharedDependencies = true;
    ctx.saveState({ ...s });
  }
  ctx.progress(0, `dependencies: ${outcome ?? 'unknown'}`);
  return null;
}

/**
 * herdr's agent start, its timeout (`timeout`: Claude never came up while herdr waited, issue #462) answered
 * as a start that timed out, with the pane's last output.
 */
async function startAgent(d: StartDeps, s: PaneState, args: string[]): Promise<Awaited<ReturnType<HerdrClient['startAgent']>> | StartTimedOut> {
  try {
    return await d.herdr.startAgent({ name: s.agentName, paneId: s.paneId, args, timeoutMs: START_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof HerdrError) || err.code !== 'timeout') throw err;
    const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 }).catch((e: unknown) => `(the pane could not be read: ${(e as Error).message})`);
    return { startTimedOut: `herdr: ${err.message}: ${tail(screen, 30)}` };
  }
}

/**
 * Start Claude in the pane, in the job's own worktree when it gets one (`s` moves there). Resolves null
 * when Claude is ready for the prompt (or the signal fired — the caller checks), a start that timed out
 * (issue #462), else the failure to report; the caller closes the pane. Claude starts in a session whose id
 * the hopper chose, or (`resume`) resumes that session (issue #501); once it is up, the id is the job's
 * `agentSession`. A parked job's worktree is still there: the worktree command finds it and enters it.
 */
export async function startClaude(d: StartDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, resume?: string): Promise<ExecutionOutcome | StartTimedOut | null> {
  const unmade = await makeScratch(d, ctx, s, p.makeWorkTree === true);
  if (unmade || ctx.signal.aborted) return unmade;
  const unscoped = await enterScope(d, ctx, s);
  if (unscoped || ctx.signal.aborted) return unscoped;
  if (d.jobWorktrees || p.repo) {
    const unentered = await enterJobWorktree(d, ctx, s, p.repo);
    if (unentered || ctx.signal.aborted) return unentered;
    if (s.jobWorktree && d.sharedDependencies) {
      const unshared = await shareDependencies(d, ctx, s);
      if (unshared || ctx.signal.aborted) return unshared;
    }
  }
  const session = resume ?? (d.newSession ?? randomUUID)();
  const args = [...d.claudeArgs, ...(p.model ? ['--model', p.model] : []), ...(resume ? ['--resume', resume] : ['--session-id', session])];
  const until = d.clock.now().getTime() + START_TIMEOUT_MS;
  let started = await startAgent(d, s, args);
  // A pane spawned a moment ago is not at its shell prompt yet; herdr refuses `agent start` until it is.
  while ('ok' in started && !started.ok && 'paneBusy' in started) {
    if (ctx.signal.aborted) return null;
    if (d.clock.now().getTime() >= until) return { startTimedOut: `pane ${s.paneId} never reached its shell prompt within ${START_TIMEOUT_MS} ms` };
    await d.sleep(SHELL_RETRY_MS, ctx.signal);
    started = await startAgent(d, s, args);
  }
  if ('startTimedOut' in started) return started;
  // Started, or held at a dialog (herdr's agent_not_ready): either way, a dialog may stand before the prompt.
  const settled = await settleStartup(d, ctx, s, started.ok);
  if (!settled && !ctx.signal.aborted) ctx.agentSession?.(session);
  return settled;
}

/**
 * Starts of one run (issue #462): a start that times out is tried again in a new pane, after a pause
 * that grows and is spread at random, so lanes that filled at once do not start again at once.
 */
const START_ATTEMPTS = 3;
const START_PAUSES_MS = [10000, 30000];
const START_PAUSE_SPREAD = 0.5;

/** What the executor does around each start of `startInPane`. */
export interface StartHooks {
  /** The pane's environment, placed afresh for each start: the close of a failed one reaped the scratch dir, credentials too. */
  env(): Promise<Record<string, string>>;
  /** A pane just opened: the outcome that refuses it (another lane holds it), or null once the executor holds it. */
  opened(s: PaneState): ExecutionOutcome | null;
  /** A start that failed: its pane is closed. */
  close(s: PaneState): Promise<void>;
  /** Spreads the pause before a start is tried again. */
  random(): number;
  /** The agent session a parked job resumes (issue #501). */
  resume?: string;
}

/**
 * Open the job's pane in `p.cwd` and start Claude there, tried again in a new pane when the start times out
 * (issue #462): nothing of the job has run yet. The pane's state once Claude is ready, else the outcome or
 * interrupt that ends the run.
 */
export async function startInPane(d: StartDeps, ctx: ExecutionContext, p: ClaudeJobPayload, h: StartHooks): Promise<PaneState | ExecutionOutcome | Interrupt> {
  for (let attempt = 1; ; attempt++) {
    const s = await openPane(d, ctx, p.cwd, await h.env());
    const refused = h.opened(s);
    if (refused) return refused;
    if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
    const failed = await startClaude(d, ctx, s, p, h.resume);
    if (!failed) return ctx.signal.aborted ? { interrupt: abortReason(ctx.signal) } : s;
    await h.close(s);
    if (!('startTimedOut' in failed)) return failed;
    if (attempt >= START_ATTEMPTS) return { kind: 'failed', error: `claude did not start in ${attempt} attempts: ${failed.startTimedOut}` };
    const pause = Math.round(START_PAUSES_MS[attempt - 1]! * (1 + START_PAUSE_SPREAD * h.random()));
    ctx.progress(0, `claude did not start (attempt ${attempt} of ${START_ATTEMPTS}), trying again in a new pane in ${Math.round(pause / 1000)} s: ${failed.startTimedOut}`);
    await d.sleep(pause, ctx.signal);
    if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
  }
}
