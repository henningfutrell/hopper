// A scriptable HerdrClient simulating Claude Code in panes, for tests (this repo's and the
// engine's integration tests). Each prompt plays the next scripted turn: while working it
// appends one `steps` line per `getAgent` poll, then the turn's `output`, and settles in `end`.

import { HerdrError } from './client.ts';
import { CTRL_END } from './screen.ts';
import type { AgentInfo, AgentStatus, HerdrClient } from './client.ts';

export interface FakeTurn {
  /** Lines appended while working, one per poll. */
  steps?: string[];
  /** Lines appended when the turn ends (assistant output, markers). */
  output: string[];
  /** State after the turn. Default `idle`. `exit`: Claude quits. `working`: never ends. */
  end?: 'idle' | 'blocked' | 'exit' | 'working';
  /**
   * Claude Code's transcript stays scrolled up (seen live after a long prompt): the output is
   * hidden behind "N new message (ctrl+End) ↓" until Ctrl+End (ESC [1;5F) is sent as text.
   */
  hiddenUntilScrolled?: boolean;
}

export { CTRL_END };

export interface FakeHerdrOptions {
  turns?: FakeTurn[];
  /** Startup blocks on the folder-trust dialog naming this path. */
  trustDialogFor?: string;
  /**
   * Startup shows Claude's bypass permissions warning (after the trust dialog, when both): herdr's agent
   * start answers `notReady` at it, or (`started`) reports Claude started while the warning is up.
   */
  bypassDialog?: 'not-ready' | 'started';
  /** Startup blocks on some other screen. */
  startupBlockedBy?: string[];
  /** The first N `runInPane` commands are lost, as a shell not at its prompt yet drops what is typed. */
  shellDropsRuns?: number;
  /** Directories the pane's shell cannot enter on this machine: a `cd` into one fails, as for a path that is not there (issue #323). */
  unusableDirs?: string[];
  /** The first N `startAgent` calls answer `paneBusy`, as herdr does for a pane spawned a moment ago. */
  shellNotReadyStarts?: number;
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

interface Pane {
  id: string;
  lines: string[];
  closed: boolean;
  agent?: string;
  status: AgentStatus;
  seq: number;
  mode: 'none' | 'trust' | 'bypass' | 'startup';
  turn?: FakeTurn;
  step: number;
  ctrlC: number;
  sawDown: boolean;
  hidden?: string[];
  /** Text pasted into the input box, not submitted. */
  input?: string;
}

export interface FakeHerdrClient extends HerdrClient {
  readonly calls: { method: string; args: unknown[] }[];
  readonly prompts: { name: string; text: string }[];
  readonly keys: { paneId: string; keys: string[] }[];
  readonly texts: { paneId: string; text: string }[];
  readonly closed: string[];
  readonly agentStarts: { name: string; paneId: string; args: string[]; timeoutMs: number }[];
  addTurns(...turns: FakeTurn[]): void;
  /** The next N prompts never reach Claude, as `dropsPrompts`. */
  dropPrompts(n: number): void;
  /** Claude disappears from its pane (crashed, closed by hand). */
  killAgent(name: string): void;
  /** The next call of `method` rejects with a HerdrError of this code. */
  failNext(method: keyof HerdrClient, code: string): void;
  screen(paneId: string): string;
}

const CHROME = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  text.split('\n').forEach((para, i) => {
    let line = i === 0 ? '❯' : ' ';
    for (const word of para.split(' ')) {
      if (line.length + 1 + word.length > width && line.trim() !== '' && line !== '❯') {
        out.push(line);
        line = ' ';
      }
      line += ` ${word}`;
    }
    out.push(line);
  });
  return out;
}

function trustDialog(path: string): string[] {
  return [
    '─'.repeat(40), ' Accessing workspace:', '', ` ${path}`, '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.", '',
    ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel',
  ];
}

function bypassDialog(): string[] {
  return [
    '─'.repeat(40), ' WARNING: Claude Code running in Bypass Permissions mode', '',
    ' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.', '',
    ' By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.', '',
    ' ❯ No, exit', '   Yes, I accept', '', ' Enter to confirm · Esc to cancel',
  ];
}

export function createFakeHerdrClient(o: FakeHerdrOptions = {}): FakeHerdrClient {
  const turns = [...(o.turns ?? [])];
  const width = o.width ?? 100;
  const panes = new Map<string, Pane>();
  const failures = new Map<string, string>();
  let n = 0;
  let busyStarts = o.shellNotReadyStarts ?? 0;
  let droppedRuns = o.shellDropsRuns ?? 0;
  let droppedPrompts = o.dropsPrompts ?? 0;
  let droppedPicks = o.dropsDialogPicks ?? 0;
  let leftInInput = o.promptsLeftInInput ?? 0;
  let workspaceId: string | undefined;

  const record = (method: keyof HerdrClient, ...args: unknown[]): void => {
    fake.calls.push({ method, args });
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
  const exit = (p: Pane): void => { p.agent = undefined; p.status = 'unknown'; p.lines.push('$ '); };

  const submit = (p: Pane, text: string): void => {
    p.input = undefined;
    p.lines.push(...wrap(text, width));
    p.turn = turns.shift() ?? { output: [] };
    p.step = 0;
    settle(p, 'working');
  };

  const advance = (p: Pane): void => {
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
    if (t.end === 'exit') exit(p);
    else settle(p, t.end === 'blocked' ? 'blocked' : 'idle');
  };

  const fake: FakeHerdrClient = {
    session: o.session,
    calls: [], prompts: [], keys: [], texts: [], closed: [], agentStarts: [],
    addTurns: (...more) => { turns.push(...more); },
    dropPrompts: (count) => { droppedPrompts = count; },
    killAgent(name) { const p = byAgent(name); if (p) exit(p); },
    failNext(method, code) { failures.set(method, code); },
    screen: (id) => {
      const p = panes.get(id);
      const indicator = p?.hidden ? ['                                               1 new message (ctrl+End) ↓'] : [];
      const chrome = p?.input === undefined ? CHROME : [CHROME[0]!, `❯ [Pasted text #1 +${p.input.split('\n').length - 1} lines]`, ...CHROME.slice(2)];
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
      if (o.trustDialogFor === undefined && o.bypassDialog) {
        p.mode = 'bypass';
        p.lines.push(...bypassDialog());
        settle(p, 'blocked');
        return o.bypassDialog === 'started' ? { ok: true } : { ok: false, notReady: true };
      }
      if (o.trustDialogFor !== undefined || o.startupBlockedBy) {
        p.mode = o.trustDialogFor !== undefined ? 'trust' : 'startup';
        p.lines.push(...(o.trustDialogFor !== undefined ? trustDialog(o.trustDialogFor) : o.startupBlockedBy!));
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
        p.turn = turns.shift() ?? { output: [] };
        p.step = 0;
        settle(p, 'working');
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
        else if (key === 'enter' && p.mode === 'trust' && p.sawDown && o.bypassDialog) {
          p.mode = 'bypass';
          p.sawDown = false;
          p.lines = bypassDialog();
          settle(p, 'blocked');
        } else if (key === 'enter' && (p.mode === 'trust' || p.mode === 'bypass')) {
          p.mode = 'none';
          if (p.sawDown) { p.lines = ['✻ Welcome to Claude Code']; settle(p, 'idle'); } else exit(p);
          p.sawDown = false;
        } else if (key === 'esc' && p.agent && (p.status === 'blocked' || p.status === 'working')) {
          p.lines.push('  ⎿  Interrupted');
          p.turn = undefined;
          settle(p, 'idle');
        } else if (key === 'ctrl+c' && p.agent && ++p.ctrlC >= 2) exit(p);
      }
    },
    async runInPane(paneId, command) {
      record('runInPane', paneId, command);
      const p = livePane(paneId);
      if (droppedRuns-- > 0) return;
      // `cd 'dir' && … && printf 'a%s\n' b || printf 'a%s\n' c`: c when the shell cannot enter dir, else b.
      const entered = /^cd '([^']*)' && .*printf '([^']*)%s\\n' (\S+) \|\| printf '[^']*%s\\n' (\S+)$/.exec(command);
      if (entered) {
        const [, dir, prefix, ok, bad] = entered;
        const unusable = (o.unusableDirs ?? []).includes(dir!);
        p.lines.push(`$ ${command}`, ...(unusable ? [`cd: no such file or directory: ${dir}`, `${prefix}${bad}`] : [`${prefix}${ok}`]), '$ ');
        return;
      }
      // What a trailing `printf 'a%s\n' b` prints: the shell ran the command.
      const printed = /printf '([^']*)%s\\n' (\S+)$/.exec(command);
      p.lines.push(`$ ${command}`, ...(printed ? [`${printed[1]}${printed[2]}`] : []), '$ ');
    },
    async waitOutput(paneId, text, timeoutMs) {
      record('waitOutput', paneId, text, timeoutMs);
      livePane(paneId);
      return fake.screen(paneId).includes(text);
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
