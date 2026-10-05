// The herdr-claude executor's own port onto herdr: only what the executor needs. The real
// adapter shells out to `herdr --session <s> …` (cli-client.ts); the fake simulates a Claude
// screen (fake-client.ts).

/** herdr's agent lifecycle states. `idle` and `done` both mean ready for input. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  status: AgentStatus;
  /** Increments on every lifecycle change; a turn has ended once it moved past the send. */
  stateChangeSeq: number;
  paneId: string;
}

export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped';

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

export interface HerdrClient {
  /** The named herdr session, when the adapter has one. Recorded in executor state. */
  readonly session?: string;
  /** Workspace id of the workspace with this label; created without focus when absent. */
  ensureWorkspace(label: string, cwd: string): Promise<string>;
  /** `env`: variables for the process launched in the tab (`herdr tab create --env K=V`). */
  createTab(o: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<{ tabId: string; paneId: string }>;
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
  /** Type a shell command into the pane's shell (`herdr pane run`); does not wait for it, and a shell not at its prompt yet may drop it. */
  runInPane(paneId: string, command: string): Promise<void>;
  /** True once the pane's recent output holds `text`; false when `timeoutMs` passes first. */
  waitOutput(paneId: string, text: string, timeoutMs: number): Promise<boolean>;
  /** Rejects `pane_not_found` for a pane already gone. */
  closePane(paneId: string): Promise<void>;
}
