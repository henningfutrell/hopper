// The fake herdr's panes (fake-client.ts): their state, a new one, and the pane list as `herdr pane list` gives it
// (issue #1128, the machine's terminal). Apart from fake-client.ts for its size.
import type { AgentStatus, HerdrPane } from './client.ts';
import type { FakeTurn } from './fake-options.ts';
import type { StartupScreen } from './fake-screens.ts';

export interface Pane {
  id: string;
  /** Its tab, and the title its terminal set (`openPane`). */
  tabId?: string;
  title?: string;
  lines: string[];
  closed: boolean;
  /** Its terminal: a new one each time herdr restores the pane after a server restart (issue #1465). */
  terminal: string;
  agent?: string;
  status: AgentStatus;
  seq: number;
  mode: 'none' | StartupScreen | 'startup' | 'late';
  /** Startup screens still to come once the one on screen is answered. */
  dialogs?: StartupScreen[];
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
  /** Looks left before the late dialog shows (FakeHerdrOptions.lateDialog). */
  lateIn?: number;
  /** Background work the last turn started, still running (FakeTurn.background). */
  background?: { work: string; polls: number; wakes?: boolean; prints?: string[] };
}

/** A pane at its shell: `lines` on screen; `title`, as a person's own terminal sets it. */
export const newPane = (id: string, tabId: string, lines: string[], title?: string): Pane =>
  ({ id, tabId, ...(title ? { title } : {}), lines: [...lines], closed: false, terminal: `term_${id}_0`, status: 'unknown', seq: 0, mode: 'none', step: 0, ctrlC: 0, sawDown: false });

/** The panes not closed, as herdr lists them: an agent's as `claude`, with its state. */
export const listedPanes = (panes: Iterable<Pane>): HerdrPane[] => [...panes].filter((p) => !p.closed).map((p) => ({
  paneId: p.id, tabId: p.tabId ?? p.id, workspaceId: p.id.split(':')[0]!, ...(p.title ? { title: p.title } : {}), ...(p.agent ? { agent: 'claude', agentStatus: p.status } : { agentStatus: 'unknown' as const }),
}));
