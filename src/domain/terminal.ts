// The job's terminal at the executor port (issue #1128, design.md "The job's terminal"): what an executor whose jobs run
// in a pane gives a person — the pane's screen, and their input to it. Apart from ports.ts for its size.
import type { Job, MachineSnapshot } from './types.ts';

/** A pane of the hopper's herdr session on a machine (issue #1128, the machine's terminal), as the executor lists it. */
export interface TerminalPane {
  paneId: string;
  tabId: string;
  /** The terminal's title, as the program in it set it. */
  title?: string;
  /** The agent that runs in it (`claude`). */
  agent?: string;
  /** herdr's agent state: idle, working, blocked, done or unknown. */
  agentStatus: string;
}

/** The machine's terminal (issue #1128): every pane of the hopper's herdr session there, read and typed into by pane id. */
export interface PaneSession {
  panes(): Promise<TerminalPane[]>;
  /** The pane's last `lines` lines with the scrollback. Rejects for a pane that is gone, or a machine out of reach. */
  read(paneId: string, lines: number): Promise<string>;
  /** `text` written to the pane as it is, or `keys` pressed. Rejects as `read` does. */
  type(paneId: string, input: { text: string } | { keys: string[] }): Promise<void>;
}

export interface ExecutorTerminal {
  /**
   * The job's terminal (issue #1128): the text its pane shows now, its last `lines` lines with the scrollback, for a person
   * to view; undefined when the job holds no pane. Rejects when its machine cannot be reached. Absent → the job has none.
   */
  paneScreen?(job: Job, lines: number): Promise<string | undefined>;
  /**
   * A person's input to the job's terminal (issue #1128): `text` written to its pane as it is, or `keys` pressed (herdr's
   * key names). False: the job holds no pane. Rejects when its machine cannot be reached. Present exactly when `paneScreen` is.
   */
  typeInPane?(job: Job, input: { text: string } | { keys: string[] }): Promise<boolean>;
  /**
   * The machine's terminal (issue #1128): the hopper's herdr session on `machine`, every pane of it; undefined when this
   * executor cannot reach that machine. Absent → the executor runs no pane there.
   */
  paneSession?(machine: MachineSnapshot): PaneSession | undefined;
}
