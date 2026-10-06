// The herdr terminal (issue #189, design.md "The herdr terminal"): an actual terminal in the browser
// onto the root herdr — the herdr session on the hopper's own machine whose saved machines are the
// herdr of every attached machine it reaches over ssh. Split out of types.ts and ports.ts to stay readable.

/** One attached machine as the root herdr sees it. */
export interface HerdrTerminalMachine {
  name: string;
  label: string;
  /** The root herdr lists it: a saved herdr machine on its herdr session. */
  listed: boolean;
  /** Why it is not listed. */
  reason?: string;
  /** Since the terminal last opened: herdr saved it, or could not (`error`, herdr's words). */
  sync?: 'saved' | 'failed';
  error?: string;
}

/** GET /api/herdr-terminal. */
export interface HerdrTerminalStatus {
  /** The root herdr session on the hopper's machine. */
  session: string;
  machines: HerdrTerminalMachine[];
  /** Why the root herdr reaches no machine at all (no ssh key for the hopper). */
  problem?: string;
}

/** A saved herdr machine the root herdr should have: one per listed attached machine. */
export interface HerdrMachineProfile {
  machine: string;
  /** The sidebar's name: `<label> (<id>)`, or the id when it is the label. */
  label: string;
  /** `ssh://<user>@<host>:<port>`, the resolved destination: no ssh config is read to reach it. */
  target: string;
  /** The machine's herdr session. */
  session: string;
  /** Its pinned host key. */
  hostKey: string;
}

/** What syncing one saved herdr machine did. */
export interface HerdrMachineSync { machine: string; state: 'saved' | 'failed'; error?: string }

/** Bring the root herdr's saved machines to `profiles`, with herdr `herdr` run in `env`. */
export type SyncHerdrMachines = (o: { herdr: string; env: Record<string, string>; profiles: HerdrMachineProfile[] }) => Promise<HerdrMachineSync[]>;

/** A program on a pseudo-terminal. */
export interface Terminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface TerminalSpawn { file: string; args: string[]; env: Record<string, string>; cwd: string; cols: number; rows: number }

/** Start a program on a new pseudo-terminal. */
export type SpawnTerminal = (o: TerminalSpawn) => Terminal;

/** One user's herdr terminal. */
export interface HerdrTerminal {
  status(): HerdrTerminalStatus;
  /** A new client of the root herdr on a pseudo-terminal of this size; its saved machines are synced alongside. */
  open(size: { cols: number; rows: number }): Terminal;
}
