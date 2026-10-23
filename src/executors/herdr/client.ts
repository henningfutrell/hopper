// The herdr-claude executor's own port onto herdr: only what the executor needs. The real
// adapter shells out to `herdr --session <s> …` (cli-client.ts); the fake simulates a Claude
// screen (fake-client.ts). It is also the machine that herdr runs on, reached the same way, for the
// reap and the sweep (issue #410): `reap` and `survey` never go through a pane.
import type { MachineShell } from '../../domain/ports.ts';

/** herdr's agent lifecycle states. `idle` and `done` both mean ready for input. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  status: AgentStatus;
  /** Increments on every lifecycle change; a turn has ended once it moved past the send. */
  stateChangeSeq: number;
  paneId: string;
  /** The terminal of its pane: herdr gives the pane a new one when it restores it after a server restart (issue #1465). */
  terminalId?: string;
}

export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped';

/**
 * The longest command a pane's shell is given (issue #2234): a terminal keeps at most 4095 characters of a line it has not
 * handed on yet (Linux's N_TTY_BUF_SIZE, less the newline). A shell with a line editor (bash, zsh) takes more, one with none
 * (dash, the `sh` herdr starts where SHELL is unset, as in a sandbox box) runs a cut line, its quotes left open.
 */
export const TERMINAL_LINE_MAX = 4095;

/** A pane of the herdr session (issue #1128, the machine's terminal): what `herdr pane list` says of it, no path. */
export interface HerdrPane {
  paneId: string;
  tabId: string;
  workspaceId: string;
  /** The terminal's title, as the program in it set it. */
  title?: string;
  /** The agent herdr knows runs in it (`claude`). */
  agent?: string;
  agentStatus: AgentStatus;
}

/** A tab the hopper opened for a job, and its one pane. */
export interface HerdrTab { tabId: string; paneId: string; terminalId?: string }
/** A tab `findTab` found: `agent`, the agent herdr knows runs in its pane (`claude`), when one does. */
export type FoundTab = HerdrTab & { agent?: string };

/** `notReady`: Claude blocked at startup. `paneBusy`: the pane is not at its shell prompt yet (just spawned); retry. */
export type StartAgentResult = { ok: true } | { ok: false; notReady: true } | { ok: false; paneBusy: true };

/** A herdr server error (JSON on stderr, exit 1), a usage error, a timeout, or a failed spawn. */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

export interface HerdrClient extends MachineShell {
  /** The named herdr session, when the adapter has one. Recorded in executor state. */
  readonly session?: string;
  /** Workspace id of the workspace with this label; created without focus when absent. */
  ensureWorkspace(label: string, cwd: string): Promise<string>;
  /** `env`: variables for the process launched in the tab (`herdr tab create --env K=V`). */
  createTab(o: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<HerdrTab>;
  /** The tab of the workspace with this label and its pane (issue #1569: a create whose answer was lost made it); null when none has it. */
  findTab(o: { workspaceId: string; label: string }): Promise<FoundTab | null>;
  /** Start Claude in the pane. `notReady`: blocked at startup (e.g. the folder-trust dialog). `paneBusy`: shell not up yet. */
  startAgent(o: { name: string; paneId: string; args: string[]; timeoutMs: number }): Promise<StartAgentResult>;
  /** null when no live agent has that name. */
  getAgent(name: string): Promise<AgentInfo | null>;
  /** Raw text of the pane. */
  read(paneId: string, o: { source: ReadSource; lines: number }): Promise<string>;
  /** Submit text plus Enter to the agent. Rejects `agent_blocked` at a dialog. */
  prompt(name: string, text: string): Promise<void>;
  /** Logical keys (`esc`, `enter`, `down`, `ctrl+c`) to the pane. */
  sendKeys(paneId: string, keys: string[]): Promise<void>;
  /** Write raw text to the pane (e.g. an escape sequence herdr has no key name for). */
  sendText(paneId: string, text: string): Promise<void>;
  /**
   * Type a shell command into the pane's shell (`herdr pane run`); does not wait for it, and a shell not at its prompt yet
   * may drop it. At most TERMINAL_LINE_MAX characters: a shell with no line editor runs only what the terminal kept.
   */
  runInPane(paneId: string, command: string): Promise<void>;
  /** True once the pane's recent output holds `text`; false when `timeoutMs` passes first. */
  waitOutput(paneId: string, text: string, timeoutMs: number): Promise<boolean>;
  /** Every pane of the session (issue #1128): the ones no job holds too. */
  listPanes(): Promise<HerdrPane[]>;
  /** The label of the tab the pane is in (issue #2676: whose pane it is, by the pane key); null when no pane has that id. */
  tabLabel(paneId: string): Promise<string | null>;
  /** Rejects `pane_not_found` for a pane already gone. */
  closePane(paneId: string): Promise<void>;
  /** True while the machine's link is down (issue #752): a client target not dialled in. Absent: the machine has no link. */
  linkDown?(): boolean;
  /**
   * Calls `fn` at each **missed heartbeat** of the machine's link (issue #1569): a PING not answered within its interval,
   * before the PING timeout drops the link. Returns the call that stops it. Absent: the machine has no link.
   */
  onLinkLate?(fn: () => void): () => void;
}
