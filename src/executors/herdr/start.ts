// Opening a job's pane and getting Claude ready in it: workspace, tab, agent start, and the
// startup dialogs (folder trust; the bypass permissions warning when yolo). docs/design.md "Phase 2" → "Start".

import type { Clock, ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { HerdrClient } from './client.ts';
import type { Sleep } from './monitor.ts';
import { tail } from './monitor.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { JOB_WORKTREE_MARK, checkoutOf, checkoutWorktreeOf, jobWorktreeOf, jobWorktreeOutcome, makeJobWorktreeCommand } from './job-worktree.ts';
import { SCOPE_MARK, enterScopeCommand, scopeCheckCommand, scopeOutcome } from './job-scope.ts';
import { DEPS_MARK, depsOutcome, shareDepsCommand } from './shared-deps.ts';
import { scopeUnitOf } from '../../client/server.ts';
import { SCRATCH_DIR, isBypassDialog, isTrustDialog, windowsShellOf } from './screen.ts';
import { shellQuote } from '../ssh.ts';

export const WORKSPACE_LABEL = 'hopper';
const START_TIMEOUT_MS = 60000;
const SHELL_RETRY_MS = 100;
/** What the scratch command prints last, so the hopper knows the shell ran it. */
const SCRATCH_READY = 'hopper-scratch-ready';
/** What it prints instead when the shell cannot enter the work tree or make the scratch dir (issue #323). */
const SCRATCH_UNUSABLE = 'hopper-scratch-unusable';
const SCRATCH_WAIT_MS = 1000;
/** How long the job worktree command may take: it fetches first (issue #379), or clones the job's repository (issue #361). */
const JOB_WORKTREE_WAIT_MS = 10 * 60000;
/** How long sharing dependencies may take: the first job with a lockfile installs them (issue #410). */
const DEPS_WAIT_MS = 15 * 60000;
/** A machine's scratch age when it sets none: an entry of shared dependencies nothing links to goes after it. */
const SCRATCH_MAX_AGE_HOURS = 24;
/** Startup dialogs answered at most: folder trust and the bypass permissions warning, with room to spare. */
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
  /** state_change_seq when the turn parked on a question: Claude moving past it means the owner answered in the pane. */
  parkedSeq?: number;
  /** The parked turn waits at a dialog Claude Code denies by itself at this time (issue #376). */
  lapsesAt?: string;
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
}

export const agentNameFor = (jobId: string): string => `jh-${jobId.slice(0, 8)}`;

/** The work tree's scratch dirs, git-ignored as one (design.md "Work tree"). */
export const scratchDirOf = (cwd: string): string => `${cwd.replace(/\/+$/, '')}/${SCRATCH_DIR}`;

/**
 * The job's own scratch dir: Claude's scratchpad, every temp file, and the clones it makes only for this
 * job. Its own, so the reap can remove it when the job ends (issue #401, reap.ts).
 */
export const jobScratchOf = (cwd: string, jobId: string): string => `${scratchDirOf(cwd)}/${jobId}`;

/**
 * Create the tab and record it at once, before anything can fail in it. The tab's environment
 * points Claude's scratchpad and every temp file at the scratch dir.
 */
export async function openPane(d: StartDeps, ctx: ExecutionContext, cwd: string, env: Record<string, string>): Promise<PaneState> {
  const scratch = jobScratchOf(cwd, ctx.job.id);
  const workspaceId = await d.herdr.ensureWorkspace(WORKSPACE_LABEL, cwd);
  const { tabId, paneId } = await d.herdr.createTab({
    workspaceId, cwd, label: `${ctx.laneId} · ${ctx.job.id.slice(0, 8)}`,
    // HOPPER_JOB_ID and the scratch dir come from the hopper; a payload cannot move them. Claude Code's
    // countdown that denies a dangerous rm by itself is off (issue #376): the question climbs to the owner,
    // which takes longer than its two minutes.
    env: { ...env, CLAUDE_CODE_TMPDIR: scratch, TMPDIR: scratch, HOPPER_JOB_ID: ctx.job.id, CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '1' },
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
 * Wait until Claude is ready for the prompt, answering the startup dialogs the hopper may answer: the
 * folder-trust dialog naming the job's cwd (when `trustWorkdir`), and the bypass permissions warning
 * (when yolo). Any other dialog fails the job with the screen. A dialog is judged once per state
 * change, so keys sent to one never land on the next. `started`: herdr's agent start found Claude
 * ready, so anything but a dialog is; else herdr found it held at one. Null when ready (or aborted),
 * else the failure.
 */
async function settleStartup(d: StartDeps, ctx: ExecutionContext, s: PaneState, started: boolean): Promise<ExecutionOutcome | null> {
  const until = d.clock.now().getTime() + START_TIMEOUT_MS;
  let answeredAt = -1;
  let answered = 0;
  while (d.clock.now().getTime() < until) {
    if (ctx.signal.aborted) return null;
    const agent = await d.herdr.getAgent(s.agentName);
    if (!agent) return { kind: 'failed', error: 'claude exited at startup' };
    if (agent.status === 'idle' || agent.status === 'done' || (started && answered === 0 && agent.status !== 'blocked')) return null;
    if ((agent.status === 'blocked' || (!started && answered === 0)) && agent.stateChangeSeq !== answeredAt) {
      const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
      const dir = s.jobWorktree ?? s.cwd;
      const dialog = d.trustWorkdir && isTrustDialog(screen, dir) ? `trusted workdir ${dir}`
        : d.yolo && isBypassDialog(screen) ? 'accepted bypass permissions mode' : undefined;
      if (!dialog || answered >= MAX_STARTUP_DIALOGS) return { kind: 'failed', error: `claude blocked at startup: ${tail(screen, 30)}` };
      // Both dialogs open on their refusing option; the next one down accepts.
      await d.herdr.sendKeys(s.paneId, ['down', 'enter']);
      ctx.progress(0, dialog);
      answeredAt = agent.stateChangeSeq;
      answered++;
      continue;
    }
    await d.sleep(d.pollMs, ctx.signal);
  }
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  return { kind: 'failed', error: `claude not ready at startup: ${tail(screen, 30)}` };
}

/**
 * Make the scratch dir in the pane's own shell, so on whichever machine the work tree is; its
 * `.gitignore` hides it from git. The shell enters the work tree first: herdr opens a tab whose cwd
 * does not exist there in the home instead, so only the shell can say the work tree is not usable,
 * and then the job fails at once with what it said (issue #323). The jobs directory, and a work tree
 * under it, the shell makes first (`make`, issue #314). A fresh shell drops what is typed before its
 * prompt, so the command runs again until its output shows. The command is POSIX shell: a pane whose
 * shell is PowerShell or cmd fails the job at once, naming it (issue #367). Null when made, else the failure.
 */
async function makeScratch(d: StartDeps, ctx: ExecutionContext, s: PaneState, make: boolean): Promise<ExecutionOutcome | null> {
  const scratch = jobScratchOf(s.cwd, ctx.job.id);
  const command = `${make ? `mkdir -p ${shellQuote(s.cwd)} && ` : ''}cd ${shellQuote(s.cwd)} && mkdir -p ${shellQuote(scratch)} && printf '*\\n' > ${shellQuote(`${scratchDirOf(s.cwd)}/.gitignore`)}`
    + ` && printf 'hopper-scratch-%s\\n' ready || printf 'hopper-scratch-%s\\n' unusable`;
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += SCRATCH_WAIT_MS) {
    if (ctx.signal.aborted) return null;
    await d.herdr.runInPane(s.paneId, command);
    if (await d.herdr.waitOutput(s.paneId, SCRATCH_READY, SCRATCH_WAIT_MS)) return null;
    const screen = await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: 40 });
    if (screen.split('\n').some((l) => l.trim() === SCRATCH_UNUSABLE)) {
      return { kind: 'failed', error: `the work tree ${s.cwd} is not usable on ${ctx.machine.id}: ${tail(screen, 10)}` };
    }
    const shell = windowsShellOf(screen);
    if (shell) {
      return { kind: 'failed', error: `the shell of pane ${s.paneId} on ${ctx.machine.id} is ${shell}, and the hopper needs a POSIX shell (sh, bash, zsh) there: make one herdr's default shell for the hopper's herdr session on that machine (README "A Windows computer")` };
    }
  }
  return { kind: 'failed', error: `pane ${s.paneId} never ran the scratch dir command within ${START_TIMEOUT_MS} ms` };
}

/**
 * Move the pane's shell into the job's own systemd user scope (issue #410, job-scope.ts), when the machine
 * has a user manager: everything the job starts is then in it, and the reap stops it. The shell is replaced
 * by a new one, which drops what is typed before its prompt, so the check runs again until it answers.
 * A machine without systemd, or a shell that did not land in the scope, goes on without one. Null when
 * done, else the failure (the shell never answered: the pane is gone or hung).
 */
async function enterScope(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<ExecutionOutcome | null> {
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
  return { kind: 'failed', error: `pane ${s.paneId} never answered where its shell runs within ${START_TIMEOUT_MS} ms` };
}

/**
 * Make the job its own git worktree and move the pane's shell into it (issues #379, #361): of the work
 * tree when that is the top of a git repository; else of the checkout of the job's repository in it,
 * fetched or cloned there first. `s` then names it, saved, and it is reported as the job's work tree.
 * With job worktrees off, only the checkout is made, and the job runs in the work tree. Git refusing fails
 * the job with what it said. The scratch command has run, so the shell is at its prompt: the command is
 * typed once.
 */
async function enterJobWorktree(d: StartDeps, ctx: ExecutionContext, s: PaneState, repo: string | undefined): Promise<ExecutionOutcome | null> {
  if (repo) ctx.progress(0, `fetching or cloning ${repo} in the work tree`);
  await d.herdr.runInPane(s.paneId, makeJobWorktreeCommand(s.cwd, ctx.job.id, { ...(repo ? { repo } : {}), worktrees: d.jobWorktrees }));
  const seen = await d.herdr.waitOutput(s.paneId, JOB_WORKTREE_MARK, JOB_WORKTREE_WAIT_MS);
  const screen = await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: 40 });
  const outcome = seen ? jobWorktreeOutcome(screen) : undefined;
  if (outcome === 'none') return null;
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
  if (!await d.herdr.waitOutput(s.paneId, DEPS_MARK, DEPS_WAIT_MS)) {
    const screen = await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: 40 });
    return { kind: 'failed', error: `pane ${s.paneId} never shared dependencies within ${DEPS_WAIT_MS} ms: ${tail(screen, 10)}` };
  }
  const outcome = depsOutcome(await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: 40 }));
  if (outcome === 'linked' || outcome === 'installed') {
    s.sharedDependencies = true;
    ctx.saveState({ ...s });
  }
  ctx.progress(0, `dependencies: ${outcome ?? 'unknown'}`);
  return null;
}

/**
 * Start Claude in the pane, in the job's own worktree when it gets one (`s` moves there). Resolves null
 * when Claude is ready for the prompt (or the signal fired — the caller checks), else the failure to
 * report; the caller closes the pane.
 */
export async function startClaude(d: StartDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload): Promise<ExecutionOutcome | null> {
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
  const args = [...d.claudeArgs, ...(p.model ? ['--model', p.model] : [])];
  const until = d.clock.now().getTime() + START_TIMEOUT_MS;
  let started = await d.herdr.startAgent({ name: s.agentName, paneId: s.paneId, args, timeoutMs: START_TIMEOUT_MS });
  // A pane spawned a moment ago is not at its shell prompt yet; herdr refuses `agent start` until it is.
  while (!started.ok && 'paneBusy' in started) {
    if (ctx.signal.aborted) return null;
    if (d.clock.now().getTime() >= until) return { kind: 'failed', error: `pane ${s.paneId} never reached its shell prompt within ${START_TIMEOUT_MS} ms` };
    await d.sleep(SHELL_RETRY_MS, ctx.signal);
    started = await d.herdr.startAgent({ name: s.agentName, paneId: s.paneId, args, timeoutMs: START_TIMEOUT_MS });
  }
  // Started, or held at a dialog (herdr's agent_not_ready): either way, a dialog may stand before the prompt.
  return settleStartup(d, ctx, s, started.ok);
}
