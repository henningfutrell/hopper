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
  /** Startup blocks on some other screen. */
  startupBlockedBy?: string[];
  /** The first N `runInPane` commands are lost, as a shell not at its prompt yet drops what is typed. */
  shellDropsRuns?: number;
  /** The first N `startAgent` calls answer `paneBusy`, as herdr does for a pane spawned a moment ago. */
  shellNotReadyStarts?: number;
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
  mode: 'none' | 'trust' | 'startup';
  turn?: FakeTurn;
  step: number;
  ctrlC: number;
  sawDown: boolean;
  hidden?: string[];
}

export interface FakeHerdrClient extends HerdrClient {
  readonly calls: { method: string; args: unknown[] }[];
  readonly prompts: { name: string; text: string }[];
  readonly keys: { paneId: string; keys: string[] }[];
  readonly texts: { paneId: string; text: string }[];
  readonly closed: string[];
  readonly agentStarts: { name: string; paneId: string; args: string[]; timeoutMs: number }[];
  addTurns(...turns: FakeTurn[]): void;
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

export function createFakeHerdrClient(o: FakeHerdrOptions = {}): FakeHerdrClient {
  const turns = [...(o.turns ?? [])];
  const width = o.width ?? 100;
  const panes = new Map<string, Pane>();
  const failures = new Map<string, string>();
  let n = 0;
  let busyStarts = o.shellNotReadyStarts ?? 0;
  let droppedRuns = o.shellDropsRuns ?? 0;
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
    killAgent(name) { const p = byAgent(name); if (p) exit(p); },
    failNext(method, code) { failures.set(method, code); },
    screen: (id) => {
      const p = panes.get(id);
      const indicator = p?.hidden ? ['                                               1 new message (ctrl+End) ↓'] : [];
      return [...(p?.lines ?? []), ...indicator, ...CHROME].join('\n');
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
      p.lines.push(...wrap(text, width));
      p.turn = turns.shift() ?? { output: [] };
      p.step = 0;
      settle(p, 'working');
    },
    async sendText(paneId, text) {
      record('sendText', paneId, text);
      const p = livePane(paneId);
      fake.texts.push({ paneId, text });
      if (text === CTRL_END && p.hidden) { p.lines.push(...p.hidden); p.hidden = undefined; }
    },
    async sendKeys(paneId, keys) {
      record('sendKeys', paneId, keys);
      const p = livePane(paneId);
      fake.keys.push({ paneId, keys });
      for (const key of keys) {
        if (key !== 'ctrl+c') p.ctrlC = 0;
        if (key === 'down') p.sawDown = true;
        else if (key === 'enter' && p.mode === 'trust') {
          p.mode = 'none';
          if (p.sawDown) { p.lines = ['✻ Welcome to Claude Code']; settle(p, 'idle'); } else exit(p);
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
