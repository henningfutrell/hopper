// Windows sandbox steps (issue #731, design.md "Windows sandbox steps"): a job on a Linux machine asks the hopper to run
// one step on a Windows host over ssh, and gets its log, its exit code and its outputs back. No hopper client, lane,
// worktree or agent runs on Windows (issue #704). This file is the pure part: a Windows host as the config record
// `windows-hosts` keeps it, a step's request, and why either is not one.
import { HOST_KEY } from './machines.ts';
import { VAULT_SECRET_NAME } from './vault.ts';

/** The config record that holds a user's Windows hosts. */
export const WINDOWS_HOSTS = 'windows-hosts';

/**
 * A Windows host steps run on: OpenSSH with key auth and PowerShell, reached directly (no jump host). The hopper proves
 * itself with its own ssh key, as it does to an ssh target, and trusts only the pinned host key.
 */
export interface WindowsHost {
  /** How a job names it: `sh "$HOPPER_STEP" run NAME`. */
  name: string;
  label?: string;
  /** The ssh destination: a plain `user@host` or `host`. */
  ssh: string;
  /** Its pinned host key, `<type> <base64>`: the only key the hopper accepts from it. */
  hostKey: string;
  /** The working directory every step runs in, an absolute Windows path (`C:\work\app`). Inputs land in it, outputs come from it. */
  workDir: string;
  /**
   * The user's vault secrets a step on this host may be given (issue #731): the upper bound a person sets, as a template's
   * scope is for a box. A step asks for some of them by name; each also needs the job's vault grant. Absent: none.
   */
  secrets?: string[];
}

/** The record's value. */
export interface WindowsHostsConfig { hosts: WindowsHost[] }

/** `GET /api/windows-hosts`: the hosts, and the record's version to edit against. */
export interface WindowsHostsView { hosts: WindowsHost[]; version: string }

/** `POST /ui/api/windows-hosts`: the hosts, whole, against the version read. */
export interface WindowsHostsEdit { hosts: WindowsHost[]; version: string }

export const MAX_WINDOWS_HOSTS = 20;
/** The most vault secrets a host may give its steps, and a step may ask for. */
export const MAX_HOST_SECRETS = 32;
export const MAX_STEP_SECRETS = 16;
export const WINDOWS_HOST_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A plain `[user@]host`: it is also the host key's name in known_hosts, and an argument to ssh and scp. */
export const WINDOWS_SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;
/**
 * An absolute Windows path, drive letter first. It goes into a PowerShell single-quoted string and an scp path, so no
 * quote, no control character, no `..`, and no character a shell or scp reads.
 */
export const WINDOWS_WORK_DIR = /^[A-Za-z]:[\\/](?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9 ._()\\/-]*$/;

/** Why `w` is not a Windows host, or undefined. */
function hostProblem(w: unknown): string | undefined {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) return 'each Windows host is an object';
  const h = w as Record<string, unknown>;
  const known = ['name', 'label', 'ssh', 'hostKey', 'workDir', 'secrets'];
  const extra = Object.keys(h).find((k) => !known.includes(k));
  if (extra) return `a Windows host has no field ${extra}`;
  if (typeof h.name !== 'string' || !WINDOWS_HOST_NAME.test(h.name)) return 'a Windows host\'s name is lower case letters, digits and -, at most 40';
  const at = `Windows host ${h.name}`;
  if (h.label !== undefined && (typeof h.label !== 'string' || h.label.length > 80)) return `${at}: the label is a text of at most 80 characters`;
  if (typeof h.ssh !== 'string' || !WINDOWS_SSH_TARGET.test(h.ssh)) return `${at}: ssh is a plain user@host or host`;
  if (typeof h.hostKey !== 'string' || !HOST_KEY.test(h.hostKey)) return `${at}: hostKey is the pinned host key, <type> <base64>`;
  if (typeof h.workDir !== 'string' || h.workDir.length > 200 || !WINDOWS_WORK_DIR.test(h.workDir)) {
    return `${at}: workDir is an absolute Windows path such as C:\\work\\app: letters, digits, space, . _ ( ) - only`;
  }
  if (h.secrets !== undefined) {
    if (!Array.isArray(h.secrets) || h.secrets.some((n) => typeof n !== 'string' || !VAULT_SECRET_NAME.test(n))) return `${at}: secrets is a list of vault secret names (the user's own, not system/ or shared/)`;
    if (h.secrets.length > MAX_HOST_SECRETS) return `${at}: at most ${MAX_HOST_SECRETS} secrets`;
    const names = h.secrets as string[];
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return `${at}: secrets names ${twice} twice`;
  }
  return undefined;
}

/** Why `raw` cannot be the `windows-hosts` record, or undefined. */
export function windowsHostsProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { hosts?: unknown }).hosts)) return 'the Windows hosts are { "hosts": [...] }';
  const extra = Object.keys(raw).find((k) => k !== 'hosts');
  if (extra) return `the Windows hosts have no field ${extra}`;
  const hosts = (raw as { hosts: unknown[] }).hosts;
  if (hosts.length > MAX_WINDOWS_HOSTS) return `at most ${MAX_WINDOWS_HOSTS} Windows hosts`;
  for (const h of hosts) {
    const p = hostProblem(h);
    if (p) return p;
  }
  const names = hosts.map((h) => (h as WindowsHost).name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  return twice ? `two Windows hosts are named ${twice}` : undefined;
}

/** The hosts a record holds; none while there is no record, or one that does not load. */
export function windowsHostsOf(raw: unknown): WindowsHost[] {
  return raw === undefined || windowsHostsProblem(raw) ? [] : (raw as WindowsHostsConfig).hosts;
}

// ---- A step ----------------------------------------------------------------------------------

/** How long a step may run unless the job says: 30 minutes. At most 4 hours. */
export const STEP_DEFAULT_TIMEOUT_S = 30 * 60;
export const STEP_MAX_TIMEOUT_S = 4 * 60 * 60;
/**
 * The most a step's command may hold, and its inputs (a tar). The command travels in the request's URL, so it stays
 * small: a longer one is a script the job sends with its inputs (`--script FILE`). The inputs are kept in the database
 * until the step runs, so any host can run it (issue #1611).
 */
export const STEP_COMMAND_MAX_BYTES = 4 * 1024;
export const STEP_INPUTS_MAX_BYTES = 32 * 1024 * 1024;
/** The most a step's outputs (a tar) may hold: they are kept in the database until the job reads them (issue #1611). */
export const STEP_OUTPUTS_MAX_BYTES = 32 * 1024 * 1024;
export const STEP_MAX_OUTPUTS = 20;
/**
 * An output: a file or directory relative to the host's working directory, as tar names it. No `..`, no drive, no
 * leading slash, no wildcard, no quote: it goes into a PowerShell single-quoted string.
 */
export const STEP_OUTPUT = /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9 ._()/\\-]{1,200}$/;

/**
 * What a job asks: run `command` (PowerShell) on the Windows `host`, its inputs extracted in the working directory first.
 * A need step's request (src/sandbox/need-steps.ts) names its template as the host.
 */
export interface StepRequest {
  host: string;
  command: string;
  timeoutSeconds: number;
  /** Paths relative to the working directory the hopper brings back as a tar. */
  outputs: string[];
  /** The vault secrets the step gets in its environment, each by its own name: none of them is given to the job. */
  secrets: string[];
}

/** The request the job's fields make, or why not. */
export function stepRequestOf(f: { host?: string; command?: string; timeout?: string; outputs: string[]; secrets?: string[] }): StepRequest | { problem: string } {
  if (!f.host) return { problem: 'name the Windows host: sh "$HOPPER_STEP" hosts lists them' };
  if (!f.command || f.command.trim() === '') return { problem: 'give the command to run (PowerShell): --command TEXT or --script FILE' };
  if (Buffer.byteLength(f.command, 'utf8') > STEP_COMMAND_MAX_BYTES) return { problem: `the command may hold at most ${STEP_COMMAND_MAX_BYTES / 1024} KiB: send a longer one as a script (--script FILE)` };
  let timeoutSeconds = STEP_DEFAULT_TIMEOUT_S;
  if (f.timeout !== undefined) {
    if (!/^\d{1,6}$/.test(f.timeout) || Number(f.timeout) < 1 || Number(f.timeout) > STEP_MAX_TIMEOUT_S) return { problem: `the timeout is whole seconds, 1 to ${STEP_MAX_TIMEOUT_S}` };
    timeoutSeconds = Number(f.timeout);
  }
  if (f.outputs.length > STEP_MAX_OUTPUTS) return { problem: `at most ${STEP_MAX_OUTPUTS} outputs` };
  const bad = f.outputs.find((o) => !STEP_OUTPUT.test(o));
  if (bad !== undefined) return { problem: `output ${JSON.stringify(bad)} is not a path relative to the working directory (letters, digits, space, . _ ( ) - / \\; no ..)` };
  const secrets = [...new Set(f.secrets ?? [])];
  if (secrets.length > MAX_STEP_SECRETS) return { problem: `at most ${MAX_STEP_SECRETS} secrets` };
  const name = secrets.find((n) => !VAULT_SECRET_NAME.test(n));
  if (name !== undefined) return { problem: `${JSON.stringify(name)} is not a vault secret name: sh "$HOPPER_STEP" hosts lists the secrets each host may give` };
  return { host: f.host, command: f.command, timeoutSeconds, outputs: f.outputs, secrets };
}

/** What a step came to. `problem`: the hopper could not run it, or bring its outputs back, and why. */
export interface StepResult {
  exit: number;
  /** The outputs tar's size, when the step asked for outputs and they came back. */
  outputsBytes?: number;
  /** The outputs tar's sha256 as the need box made it, checked on arrival (issue #2288). */
  outputsSha256?: string;
  problem?: string;
}

/**
 * The seam where a step runs (re-exported by ports.ts): over ssh to a Windows host in production
 * (src/windows-steps/ssh-host.ts), a double in tests. One step at a time per host: the step's host lease in the database
 * serializes (issue #1611).
 */
export interface WindowsStepHost {
  /**
   * Run one step: copy the inputs (`<dir>/inputs.tar`, when `inputs`) and the command to the host, extract the inputs in
   * its working directory, run the command there in PowerShell, then bring `outputs` back as `<dir>/outputs.tar`. `dir`
   * is this step's own directory on this machine. `secrets`: values the step gets in its environment, by name, never
   * in an argument or a file. Every chunk of the command's output goes to `log` as it comes.
   * `signal` aborts: the timeout, or the job gone. Resolves with the exit code; never rejects — a failure of its own is
   * `problem`.
   */
  run(host: WindowsHost, step: { id: string; command: string; dir: string; inputs: boolean; outputs: string[]; secrets?: Readonly<Record<string, string>> },
    io: { log(chunk: string): void; signal: AbortSignal }): Promise<StepResult>;
  /**
   * Removes the step's scratch directory from the host's working directory (issue #1611): after each step, and after a
   * step a stopped hopper left. Rejects when the host could not be reached: the caller tries again.
   */
  sweep(host: WindowsHost): Promise<void>;
}

// ---- A step kept (issue #1611, design.md "Windows sandbox steps") ------------------------------

/**
 * A Windows step as the hopper keeps it, in the instance's `windows_steps` table, from the job's ask to an hour after
 * its result: so it lives in no request and in no one hopper's memory. A `windows-step` saga runs it on any host.
 */
export interface WindowsStep {
  id: string;
  userId: string;
  jobId: string;
  /** The job's key for the ask: one step per job and key. */
  key: string;
  /** The saga that runs it, once it is begun. */
  saga?: string;
  host: string;
  command: string;
  timeoutSeconds: number;
  outputs: string[];
  /** The vault secrets it asks for, by name: read when it runs, never kept. */
  secrets: string[];
  inputsBytes: number;
  createdAt: string;
  /** The job said the step is safe to run again: a hopper that stops while it runs runs it again (issue #2117). */
  rerun?: true;
  /** How many times it started on its host, when more than once (a rerun). */
  runs?: number;
  /** When it took its host: from then it may have had its effect there, so it is never run a second time, unless `rerun`. */
  leasedAt?: string;
  /** Its host lease holds now: no other step of the user runs there until its scratch is swept. */
  hostLeased?: true;
  result?: StepResult;
  endedAt?: string;
}

/** The Windows steps, in the instance's `windows_steps` table. */
export interface WindowsStepRepository {
  /** Keeps a new step with its inputs; a step of the same job and key kept already is answered instead, unchanged. */
  add(step: WindowsStep, inputs: Buffer): WindowsStep;
  get(id: string): WindowsStep | undefined;
  /** Names the saga that runs the step. */
  sagaIs(id: string, saga: string): void;
  /** The inputs the job sent; undefined: none, or the step ended. */
  inputs(id: string): Buffer | undefined;
  /** Adds to the step's log, until it holds STEP_LOG_MAX characters. */
  appendLog(id: string, text: string): void;
  /** The log from character `from`, and where the next read starts. */
  log(id: string, from: number): { text: string; next: number };
  /** The step ended: its result and outputs kept, its inputs dropped. Only a step not ended yet: whether this end is kept. */
  end(id: string, result: StepResult, at: string, outputs?: Buffer): boolean;
  outputs(id: string): Buffer | undefined;
  /**
   * The host lease: the step takes its host, only while no other step of its user has a lease on that host and the
   * step never had one before. Whether the step has the lease now, by this call.
   */
  leaseHost(id: string, at: string): boolean;
  /** The step runs again on the host it has the lease on (a rerun, issue #2117): its runs counted. */
  runAgain(id: string): void;
  /** The step lets its host go: its host lease ends. */
  releaseHost(id: string): void;
  /** Removes the steps that ended before `before` and have no host lease. */
  sweep(before: string): void;
}

/** The most times a step asked with rerun runs: a hopper that stops while it runs runs it again, until then (issue #2117). */
export const STEP_RUNS_MAX = 3;

/** The most of a step's log the database keeps: more is cut, and the log says so. */
export const STEP_LOG_MAX = 4 * 1024 * 1024;
