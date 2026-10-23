// A scriptable HerdrClient simulating Claude Code in panes, for tests (this repo's and the
// engine's integration tests). Each prompt plays the next scripted turn: while working it
// appends one `steps` line per `getAgent` poll, then the turn's `output`, and settles in `end`.

import { HerdrError } from './client.ts';
import { fakeMachineShell } from './fake-machine.ts';
import { echoOf, seedSays, shellSays, type FakeClaudeConfig } from './fake-shell.ts';
import { CTRL_END } from './screen.ts';
import type { AgentInfo, AgentStatus, HerdrClient } from './client.ts';
import { listedPanes, newPane, type Pane } from './fake-panes.ts';
import type { FakeHerdrClient, FakeHerdrOptions, FakeTurn } from './fake-options.ts';
import { WINDOWS_SHELLS, enterGoesOn, paneScreen, startupScreen, startupScreens, wrap } from './fake-screens.ts';

export type { FakeHerdrClient, FakeHerdrOptions, FakeTurn }; export { CTRL_END };


export function createFakeHerdrClient(o: FakeHerdrOptions = {}): FakeHerdrClient {
  const turns = [...(o.turns ?? [])];
  const width = o.width ?? 100;
  const panes = new Map<string, Pane>();
  const failures = new Map<string, { code: string; times: number }>();
  const lostAnswers = new Set<string>(), lateListeners = new Set<() => void>();
  /** setUnreachable: every call rejects. */
  let n = 0, unreachable = false, restarts = 0;
  let busyStarts = o.shellNotReadyStarts ?? 0;
  let timedOutStarts = o.startupTimeouts ?? 0;
  let droppedRuns = o.shellDropsRuns ?? 0;
  let droppedWorktreeRuns = o.dropsWorktreeRuns ?? 0;
  let droppedPrompts = o.dropsPrompts ?? 0;
  let droppedPicks = o.dropsDialogPicks ?? 0;
  let leftInInput = o.promptsLeftInInput ?? 0;
  let workspaceId: string | undefined;
  let claudeConfig: FakeClaudeConfig = o.claudeConfig ?? 'present';
  let signedIn = o.notSignedIn !== true;

  const onMachine = (method: keyof HerdrClient, ...args: unknown[]): void => {
    record(method, ...args);
    if (o.machineUnreachable) throw new Error('the machine cannot be reached');
  };
  const record = (method: keyof HerdrClient, ...args: unknown[]): void => {
    fake.calls.push({ method, args });
    if (unreachable) throw new HerdrError('client', 'client is not dialled in');
    const failure = failures.get(method);
    if (failure) {
      if (--failure.times <= 0) failures.delete(method);
      throw new HerdrError(failure.code, `${method} failed: ${failure.code}`);
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
  /**
   * The next startup screen, Claude blocked at it. The first is shown below what started Claude, and moves
   * state_change_seq; each next one replaces the one answered and moves nothing, as herdr does between Claude's
   * startup dialogs (seen live, issue #533).
   */
  const showDialog = (p: Pane): void => {
    const next = p.dialogs!.shift()!;
    const lines = startupScreen(next, o);
    p.sawDown = false;
    if (p.mode === 'none') { p.lines.push(...lines); p.mode = next; settle(p, 'blocked'); return; }
    [p.lines, p.mode] = [lines, next];
  };
  /** The startup screen on show is answered: the next one, or Claude's prompt. */
  const goOn = (p: Pane): void => {
    if (p.dialogs?.length) return showDialog(p);
    [p.mode, p.lines] = ['none', ['✻ Welcome to Claude Code']];
    settle(p, 'idle');
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
    if (p.lateIn !== undefined && p.status !== 'blocked' && !p.turn && --p.lateIn <= 0) {
      p.lateIn = undefined;
      p.lines.push(...o.lateDialog!.lines);
      [p.dialogLines, p.mode] = [o.lateDialog!.lines.length, 'late'];
      return settle(p, 'blocked');
    }
    if (p.echoPolls !== undefined) {
      if (--p.echoPolls > 0) return;
      p.echoPolls = undefined;
      p.lines.push('✻ Welcome to Claude Code');
      settle(p, 'idle');
      return;
    }
    if (p.background && p.status === 'idle' && p.background.prints?.length) p.lines.push(p.background.prints.shift()!);
    if (p.background && p.status === 'idle' && --p.background.polls <= 0) {
      const { wakes } = p.background;
      p.background = undefined;
      if (wakes !== false) wake(p);
      return;
    }
    if (p.status !== 'working' || !p.turn) return;
    const t = p.turn;
    if (p.step < (t.steps?.length ?? 0)) {
      p.lines.push(t.steps![p.step++]!);
      return;
    }
    // Its steps shown, a turn that never ends works on, silent (issue #630).
    if (t.end === 'working') return;
    if (t.hiddenUntilScrolled) p.hidden = [...t.output, '✻ Cooked for 1s'];
    else p.lines.push(...t.output, '✻ Cooked for 1s');
    p.turn = undefined;
    if (t.background) p.background = { ...t.background, ...(t.background.prints ? { prints: [...t.background.prints] } : {}) };
    if (t.end === 'blocked' && t.dialog) { p.lines.push(...t.dialog); p.dialogLines = t.dialog.length; }
    if (t.end === 'exit') exit(p);
    else settle(p, t.end === 'blocked' ? 'blocked' : 'idle');
  };

  const fake: FakeHerdrClient = {
    session: o.session,
    calls: [], prompts: [], keys: [], texts: [], closed: [], agentStarts: [], reaps: [], credentials: [], checkpoints: [], restores: [], seeds: [],
    addTurns: (...more) => { turns.push(...more); }, setTurns: (...next) => { turns.splice(0, turns.length, ...next); },
    signIn: () => { signedIn = true; },
    dropPrompts: (count) => { droppedPrompts = count; },
    restartServer() {
      restarts++;
      for (const p of panes.values()) {
        if (p.closed) continue;
        p.terminal = `term_${p.id}_${restarts}`;
        p.lines.push('$ ', ...(p.agent ? ['✻ Welcome back to Claude Code'] : []));
        p.turn = undefined;
        if (p.agent) settle(p, 'idle');
      }
    },
    killAgent(name) { const p = byAgent(name); if (p) exit(p); },
    wake(name) { const p = byAgent(name); if (p) wake(p); },
    lapseDialog(name) {
      const p = byAgent(name);
      if (!p || p.status !== 'blocked') return;
      closeDialog(p);
      p.lines.push('  ⎿  Denied: no response within 2 minutes');
      wake(p);
    },
    failNext(method, code, times = 1) { failures.set(method, { code, times }); },
    loseNextAnswer(method) { lostAnswers.add(method); },
    setUnreachable(on) { unreachable = on; },
    linkDown: () => unreachable,
    onLinkLate(fn) { lateListeners.add(fn); return () => { lateListeners.delete(fn); }; }, lateLink() { for (const fn of [...lateListeners]) fn(); },
    screen: (id) => paneScreen(panes.get(id), signedIn),
    openPane({ title, lines }) {
      n++;
      const id = `w1:p${n}`;
      panes.set(id, newPane(id, `w1:t${n}`, lines, title));
      return id;
    },

    async ensureWorkspace(label, cwd) { record('ensureWorkspace', label, cwd); workspaceId ??= 'w1'; return workspaceId; },
    async createTab(args) {
      record('createTab', args);
      n++;
      const id = `${args.workspaceId}:p${n}`;
      panes.set(id, { ...newPane(id, `${args.workspaceId}:t${n}`, ['$ ']), label: args.label });
      if (lostAnswers.delete('createTab')) throw new HerdrError('client', 'the link dropped before the answer came back');
      return { tabId: `${args.workspaceId}:t${n}`, paneId: id, terminalId: panes.get(id)!.terminal };
    },
    async findTab(args) {
      record('findTab', args);
      const p = [...panes.values()].find((x) => !x.closed && x.label === args.label && x.id.startsWith(`${args.workspaceId}:`));
      return p ? { tabId: p.tabId ?? p.id, paneId: p.id, terminalId: p.terminal, ...(p.agent ? { agent: 'claude' } : {}) } : null;
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
      if (o.lateDialog) p.lateIn = o.lateDialog.after;
      const dialogs = startupScreens(o, claudeConfig);
      if (dialogs.length > 0) {
        p.dialogs = dialogs;
        showDialog(p);
        if (o.idleAtStartupScreens) { p.status = 'idle'; return { ok: true }; }
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
      return p.agent ? { status: p.status, stateChangeSeq: p.seq, paneId: p.id, terminalId: p.terminal } : null;
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
      if (/^\d$/.test(text) && p.agent && p.mode === 'login') return goOn(p);
      // A digit at a dialog shown before anything was sent picks it: Claude is ready for the prompt.
      if (/^\d$/.test(text) && p.agent && p.status === 'blocked' && (p.mode === 'startup' || p.mode === 'late') && droppedPicks-- <= 0) {
        if (p.mode === 'late') closeDialog(p);
        else p.lines = ['✻ Welcome to Claude Code'];
        p.mode = 'none';
        return settle(p, 'idle');
      }
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
        else if (key === 'enter' && enterGoesOn(p.mode, p.sawDown) !== undefined) {
          if (enterGoesOn(p.mode, p.sawDown)) goOn(p);
          else { p.mode = 'none'; exit(p); }
        } else if (key === 'esc' && p.agent && (p.status === 'blocked' || p.status === 'working') && p.mode !== 'startup' && p.mode !== 'late') {
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
      const seed = seedSays(command, claudeConfig);
      if (seed) {
        fake.seeds.push(seed.args);
        claudeConfig = seed.config;
        p.lines.push(`$ ${command}`, seed.line, '$ ');
        return;
      }
      if (command.includes(' hopper-restore ')) fake.restores.push(command);
      const said = shellSays(command, o, p.scoped === true);
      if (said.scoped) p.scoped = true;
      if (o.worktreeLag && command.includes(' hopper-worktree ')) {
        p.lines.push(`$ ${command}`, ...said.lines.slice(0, 1));
        p.pending = { lines: [...said.lines.slice(1), '$ '], lag: o.worktreeLag };
        return;
      }
      p.lines.push(echoOf(command), ...said.lines, '$ ');
    },
    async waitOutput(paneId, text, timeoutMs) {
      record('waitOutput', paneId, text, timeoutMs);
      const p = livePane(paneId);
      if (p.pending && --p.pending.lag <= 0) { p.lines.push(...p.pending.lines); p.pending = undefined; }
      if (o.waitAnswersEarly) return o.waitAnswersEarly === 'matched';
      return fake.screen(paneId).includes(text);
    },
    ...fakeMachineShell(o, () => fake, onMachine),
    async listPanes() {
      record('listPanes');
      return listedPanes(panes.values());
    },
    async tabLabel(paneId) { record('tabLabel', paneId); const p = panes.get(paneId); return p && !p.closed ? p.label ?? '' : null; },
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
