// A scriptable HerdrClient simulating Claude Code in panes, for tests (this repo's and the
// engine's integration tests). Each prompt plays the next scripted turn: while working it
// appends one `steps` line per `getAgent` poll, then the turn's `output`, and settles in `end`.

import { HerdrError } from './client.ts';
import { shellSays } from './fake-shell.ts';
import { CTRL_END } from './screen.ts';
import type { AgentInfo, AgentStatus, HerdrClient } from './client.ts';
import type { FakeHerdrClient, FakeHerdrOptions } from './fake-options.ts';
import { CHROME, WINDOWS_SHELLS, backgroundFooter, bypassDialog, importsDialog, trustDialog, wrap } from './fake-screens.ts';

export type { FakeHerdrClient, FakeHerdrOptions };

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

export { CTRL_END };

interface Pane {
  id: string;
  lines: string[];
  closed: boolean;
  agent?: string;
  status: AgentStatus;
  seq: number;
  mode: 'none' | 'trust' | 'imports' | 'bypass' | 'startup';
  /** Startup dialogs still to come once the one on screen is answered. */
  dialogs?: ('trust' | 'imports' | 'bypass')[];
  /** Lines the shell prints after `lag` more waits (FakeHerdrOptions.worktreeLag). */
  pending?: { lines: string[]; lag: number };
  turn?: FakeTurn;
  step: number;
  ctrlC: number;
  sawDown: boolean;
  hidden?: string[];
  /** Text pasted into the input box, not submitted. */
  input?: string;
  /** Lines at the end of `lines` that are the dialog on screen (FakeTurn.dialog), removed when it closes. */
  dialogLines?: number;
  /** The shell runs in the job's scope (issue #410). */
  scoped?: boolean;
  /** Looks left before Claude draws over its echoed launch line (FakeHerdrOptions.startupEcho). */
  echoPolls?: number;
  /** Background work the last turn started, still running (FakeTurn.background). */
  background?: { work: string; polls: number; wakes?: boolean };
}

export function createFakeHerdrClient(o: FakeHerdrOptions = {}): FakeHerdrClient {
  const turns = [...(o.turns ?? [])];
  const width = o.width ?? 100;
  const panes = new Map<string, Pane>();
  const failures = new Map<string, string>();
  /** setUnreachable: every call rejects. */
  let n = 0, unreachable = false;
  let busyStarts = o.shellNotReadyStarts ?? 0;
  let timedOutStarts = o.startupTimeouts ?? 0;
  let droppedRuns = o.shellDropsRuns ?? 0;
  let droppedWorktreeRuns = o.dropsWorktreeRuns ?? 0;
  let droppedPrompts = o.dropsPrompts ?? 0;
  let droppedPicks = o.dropsDialogPicks ?? 0;
  let leftInInput = o.promptsLeftInInput ?? 0;
  let workspaceId: string | undefined;

  const record = (method: keyof HerdrClient, ...args: unknown[]): void => {
    fake.calls.push({ method, args });
    if (unreachable) throw new HerdrError('client', 'client is not dialled in');
    const code = failures.get(method);
    if (code) {
      failures.delete(method);
      throw new HerdrError(code, `${method} failed: ${code}`);
    }
  };
  const livePane = (id: string): Pane => {
    const p = panes.get(id);
    if (!p || p.closed) throw new HerdrError('pane_not_found', `pane ${id} not found`);
    return p;
  };
  const byAgent = (name: string): Pane | undefined => [...panes.values()].find((p) => !p.closed && p.agent === name);
  const settle = (p: Pane, status: AgentStatus): void => { p.status = status; p.seq++; };
  /** The dialog on screen closes (picked, lapsed, dismissed): its lines go. */
  const closeDialog = (p: Pane): void => { if (p.dialogLines) p.lines.splice(-p.dialogLines); p.dialogLines = undefined; };
  /** The next startup dialog on screen, Claude blocked at it. */
  const showDialog = (p: Pane): void => {
    const next = p.dialogs!.shift()!;
    const lines = next === 'trust' ? trustDialog(o.trustDialogFor!) : next === 'imports' ? importsDialog(o.importsDialog!) : bypassDialog();
    // The first is shown below what started Claude; each next one replaces the one answered.
    if (p.mode === 'none') p.lines.push(...lines);
    else p.lines = lines;
    p.mode = next;
    settle(p, 'blocked');
  };
  const exit = (p: Pane): void => { p.agent = undefined; p.status = 'unknown'; p.lines.push('$ '); };

  /** Claude goes on with the next scripted turn. */
  const wake = (p: Pane): void => {
    p.turn = turns.shift() ?? { output: [] };
    p.step = 0;
    settle(p, 'working');
  };

  const submit = (p: Pane, text: string): void => {
    p.input = undefined;
    p.lines.push(...wrap(text, width));
    wake(p);
  };

  const advance = (p: Pane): void => {
    if (p.echoPolls !== undefined) {
      if (--p.echoPolls > 0) return;
      p.echoPolls = undefined;
      p.lines.push('✻ Welcome to Claude Code');
      settle(p, 'idle');
      return;
    }
    if (p.background && p.status === 'idle' && --p.background.polls <= 0) {
      const { wakes } = p.background;
      p.background = undefined;
      if (wakes !== false) wake(p);
      return;
    }
    if (p.status !== 'working' || !p.turn) return;
    const t = p.turn;
    if (t.end === 'working') return;
    if (p.step < (t.steps?.length ?? 0)) {
      p.lines.push(t.steps![p.step++]!);
      return;
    }
    if (t.hiddenUntilScrolled) p.hidden = [...t.output, '✻ Cooked for 1s'];
    else p.lines.push(...t.output, '✻ Cooked for 1s');
    p.turn = undefined;
    if (t.background) p.background = { ...t.background };
    if (t.end === 'blocked' && t.dialog) { p.lines.push(...t.dialog); p.dialogLines = t.dialog.length; }
    if (t.end === 'exit') exit(p);
    else settle(p, t.end === 'blocked' ? 'blocked' : 'idle');
  };

  const fake: FakeHerdrClient = {
    session: o.session,
    calls: [], prompts: [], keys: [], texts: [], closed: [], agentStarts: [], reaps: [], credentials: [],
    addTurns: (...more) => { turns.push(...more); },
    dropPrompts: (count) => { droppedPrompts = count; },
    killAgent(name) { const p = byAgent(name); if (p) exit(p); },
    wake(name) { const p = byAgent(name); if (p) wake(p); },
    lapseDialog(name) {
      const p = byAgent(name);
      if (!p || p.status !== 'blocked') return;
      closeDialog(p);
      p.lines.push('  ⎿  Denied: no response within 2 minutes');
      wake(p);
    },
    failNext(method, code) { failures.set(method, code); },
    setUnreachable(on) { unreachable = on; },
    screen: (id) => {
      const p = panes.get(id);
      const indicator = p?.hidden ? ['                                               1 new message (ctrl+End) ↓'] : [];
      const box = p?.input === undefined ? CHROME.slice(0, 3) : [CHROME[0]!, `❯ [Pasted text #1 +${p.input.split('\n').length - 1} lines]`, CHROME[2]!];
      const chrome = [...box, p?.background ? backgroundFooter(p.background.work) : CHROME[3]!];
      return [...(p?.lines ?? []), ...indicator, ...chrome].join('\n');
    },

    async ensureWorkspace(label, cwd) {
      record('ensureWorkspace', label, cwd);
      workspaceId ??= 'w1';
      return workspaceId;
    },
    async createTab(args) {
      record('createTab', args);
      n++;
      const id = `${args.workspaceId}:p${n}`;
      panes.set(id, { id, lines: ['$ '], closed: false, status: 'unknown', seq: 0, mode: 'none', step: 0, ctrlC: 0, sawDown: false });
      return { tabId: `${args.workspaceId}:t${n}`, paneId: id };
    },
    async startAgent(args) {
      record('startAgent', args);
      if (busyStarts-- > 0) return { ok: false, paneBusy: true };
      fake.agentStarts.push(args);
      const p = livePane(args.paneId);
      p.agent = args.name;
      p.lines.push(`claude ${args.args.join(' ')}`);
      if (timedOutStarts-- > 0) {
        p.lines.push(...(o.startupTimeoutScreen ?? []));
        settle(p, 'unknown');
        throw new HerdrError('timeout', 'timed out waiting for agent startup');
      }
      const dialogs = ([o.trustDialogFor !== undefined && 'trust', o.importsDialog !== undefined && 'imports', o.bypassDialog && 'bypass'] as const)
        .filter((m): m is 'trust' | 'imports' | 'bypass' => m !== false && m !== undefined);
      if (dialogs.length > 0) {
        p.dialogs = dialogs;
        showDialog(p);
        return p.mode === 'bypass' && o.bypassDialog === 'started' ? { ok: true } : { ok: false, notReady: true };
      }
      if (o.startupEcho) {
        p.lines.push(...o.startupEcho.lines);
        p.echoPolls = o.startupEcho.polls;
        settle(p, 'blocked');
        return o.startupEcho.started ? { ok: true } : { ok: false, notReady: true };
      }
      if (o.startupBlockedBy) {
        p.mode = 'startup';
        p.lines.push(...o.startupBlockedBy);
        settle(p, 'blocked');
        return { ok: false, notReady: true };
      }
      p.lines.push('✻ Welcome to Claude Code');
      settle(p, 'idle');
      return { ok: true };
    },
    async getAgent(name): Promise<AgentInfo | null> {
      record('getAgent', name);
      const p = byAgent(name);
      if (!p) return null;
      advance(p);
      return p.agent ? { status: p.status, stateChangeSeq: p.seq, paneId: p.id } : null;
    },
    async read(paneId, opts) {
      record('read', paneId, opts);
      livePane(paneId);
      return fake.screen(paneId);
    },
    async prompt(name, text) {
      record('prompt', name, text);
      const p = byAgent(name);
      if (!p) throw new HerdrError('agent_not_found', `agent target ${name} not found`);
      if (p.status === 'blocked') throw new HerdrError('agent_blocked', `agent ${name} is blocked`);
      fake.prompts.push({ name, text });
      if (droppedPrompts-- > 0) return;
      if (leftInInput-- > 0) { p.input = (p.input ?? '') + text; return; }
      submit(p, text);
    },
    async sendText(paneId, text) {
      record('sendText', paneId, text);
      const p = livePane(paneId);
      fake.texts.push({ paneId, text });
      if (text === CTRL_END && p.hidden) { p.lines.push(...p.hidden); p.hidden = undefined; }
      // A digit at a dialog picks that option: Claude goes on with the next scripted turn.
      if (/^\d$/.test(text) && p.agent && p.status === 'blocked' && p.mode === 'none' && droppedPicks-- <= 0) {
        closeDialog(p);
        wake(p);
      }
    },
    async sendKeys(paneId, keys) {
      record('sendKeys', paneId, keys);
      const p = livePane(paneId);
      fake.keys.push({ paneId, keys });
      for (const key of keys) {
        if (key !== 'ctrl+c') p.ctrlC = 0;
        if (key === 'enter' && p.input !== undefined && p.agent && p.status !== 'blocked') submit(p, p.input);
        else if (key === 'down') p.sawDown = true;
        else if (key === 'enter' && (p.mode === 'trust' || p.mode === 'imports' || p.mode === 'bypass')) {
          // Refusing the imports goes on without them; refusing trust or the warning quits Claude.
          const goesOn = p.sawDown || p.mode === 'imports';
          p.sawDown = false;
          if (goesOn && p.dialogs?.length) showDialog(p);
          else {
            p.mode = 'none';
            if (goesOn) { p.lines = ['✻ Welcome to Claude Code']; settle(p, 'idle'); } else exit(p);
          }
        } else if (key === 'esc' && p.agent && (p.status === 'blocked' || p.status === 'working')) {
          closeDialog(p);
          p.lines.push('  ⎿  Interrupted');
          p.turn = undefined;
          settle(p, 'idle');
        } else if (key === 'ctrl+c' && p.agent && !o.ignoresCtrlC && ++p.ctrlC >= 2) exit(p);
      }
    },
    async runInPane(paneId, command) {
      record('runInPane', paneId, command);
      const p = livePane(paneId);
      if (droppedRuns-- > 0) return;
      if (command.includes(' hopper-worktree ') && droppedWorktreeRuns-- > 0) return;
      if (o.windowsShell) { const [prompt, error] = WINDOWS_SHELLS[o.windowsShell]; p.lines.push(`${prompt}${command}`, error, '', prompt); return; }
      const said = shellSays(command, o, p.scoped === true);
      if (said.scoped) p.scoped = true;
      if (o.worktreeLag && command.includes(' hopper-worktree ')) {
        p.lines.push(`$ ${command}`, ...said.lines.slice(0, 1));
        p.pending = { lines: [...said.lines.slice(1), '$ '], lag: o.worktreeLag };
        return;
      }
      p.lines.push(`$ ${command}`, ...said.lines, '$ ');
    },
    async waitOutput(paneId, text, timeoutMs) {
      record('waitOutput', paneId, text, timeoutMs);
      const p = livePane(paneId);
      if (p.pending && --p.pending.lag <= 0) { p.lines.push(...p.pending.lines); p.pending = undefined; }
      if (o.waitAnswersEarly) return o.waitAnswersEarly === 'matched';
      return fake.screen(paneId).includes(text);
    },
    async reap(jobId, scratch) {
      record('reap', jobId, scratch);
      if (o.machineUnreachable) throw new Error('the machine cannot be reached');
      fake.reaps.push({ jobId, ...(scratch ? { scratch } : {}) });
      return { kept: [...(o.reapKeeps ?? [])] };
    },
    async survey(roots) {
      record('survey', roots);
      if (o.machineUnreachable) throw new Error('the machine cannot be reached');
      return o.survey ?? { scopes: [], processes: [], scratch: [] };
    },
    async keepCredential(jobId, dir, file, content, make) {
      record('keepCredential', jobId, dir, file);
      if (o.machineUnreachable) throw new Error('the machine cannot be reached');
      fake.credentials.push({ jobId, dir, file, content, ...(make ? { make } : {}) });
    },
    async closePane(paneId) {
      record('closePane', paneId);
      const p = livePane(paneId);
      p.closed = true;
      p.agent = undefined;
      fake.closed.push(paneId);
    },
  };
  return fake;
}
