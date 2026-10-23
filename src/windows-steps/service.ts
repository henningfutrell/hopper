// One user's Windows sandbox steps (issue #731, design.md "Windows sandbox steps"). A running job's step is checked against
// the user's Windows hosts, kept in the database from the job's ask to an hour after its result (issue #1611, the
// `windows_steps` table), and run by its `windows-step` saga (step-saga.ts) on whichever host holds the saga: so a
// stop of the hopper drops no step and loses no result. One step runs on a host at a time: a step takes its host
// lease in the database before it starts there, and lets it go only once the host's scratch directory is swept. A step
// that took its host on a hopper that stopped is never run a second time: it ends saying so, as it may have had its
// effect, and its host's scratch is swept. Recorded on the job's timeline (`step.started`, `step.finished`,
// `step.refused`). A step's vault secrets (each one its host gives, and the vault gives after the job's grant) are read
// when it runs, go to the step only, are never kept, and are masked in the log the job reads. The Windows host is a port
// (`WindowsStepHost`): ssh in production, a double in tests. A box step is a need step (src/sandbox/need-steps.ts).
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { WindowsStepHost } from '../domain/ports.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import { STEP_OUTPUTS_MAX_BYTES, STEP_RUNS_MAX, stepRequestOf, type StepResult, type WindowsHost, type WindowsStep, type WindowsStepRepository } from '../domain/windows-steps.ts';
import { keptLog, withLostLog } from './step-log.ts';

/** How long a step's result and outputs are kept for the job to fetch. */
export const STEP_KEEP_MS = 60 * 60 * 1000;
/** The most of a step's command an event keeps. */
const COMMAND_IN_EVENT = 300;
/** How often a step that waits for its host asks for its host lease again, and a running step looks whether its job is at work. */
const HOLD_POLL_MS = 1_000, AT_WORK_MS = 5_000;
const ID = /^[a-f0-9-]{36}$/;

/** The problem of a step that took its host on a hopper that stopped: it is not run again (issue #1611), unless it was asked with rerun (issue #2117). */
export const STEP_INTERRUPTED = 'the hopper stopped while the step ran, and it is not run again: it may have had its effect. Look at what it changed on the host before you run it again. A step that is safe to run again (one that only reads) asks for that with --rerun';
/**
 * The problem of a step asked with rerun that a hopper ended with no stop, as a crash does (issue #2690): its output may be
 * what ended the hopper, so it is not run again, which would end the next hopper too.
 */
export const STEP_HOPPER_ENDED = 'the hopper ended while the step ran, with no stop, and the step is not run again, though it was asked with --rerun: the step may be what ended the hopper. Look at its log, and at what it changed on the host, before you run it again';
/** What the log of a step asked with rerun says when it runs again after a stop. */
export const STEP_RERUN_NOTE = 'the hopper stopped while the step ran; it runs again, as --rerun allows';

export interface WindowsStepsOptions {
  userId: string;
  /** The user's Windows hosts now: a change applies to the next step. */
  hosts(): WindowsHost[];
  host: WindowsStepHost;
  /** The Windows steps, in the database. */
  steps: WindowsStepRepository;
  /** The `windows-step` saga of a step (step-saga.ts): begun once per step, its id answered; and its abort. Absent: no step runs. */
  sagas?: { begin(step: string): string; abort(saga: string, reason: string): boolean };
  /** Whether the job is at work: a step of a job that stopped is stopped too. */
  atWork(jobId: string): boolean;
  /** Where each running step's own directory goes on this machine: the hopper's work dir (scratch). */
  dir: string;
  record(event: NewEvent): void;
  log(line: string): void;
  /** A vault secret's value for `job`'s step on `host` (the vault's grant and checks), or why not. Absent: no step gets one. */
  secret?(ask: { name: string; job: string; host: string }): Promise<{ value: string } | { refused: string }>;
  newId?: () => string;
  now?: () => Date;
  keepMs?: number;
}

/** A step's fields as the job sent them. */
export interface StepFields { host?: string; command?: string; timeout?: string; outputs: string[]; secrets?: string[]; rerun?: boolean }

/** What the job sent with its ask: its key for the ask, and the inputs (a tar; empty: none). */
export interface StepAsk { key: string; inputs: Buffer }

/** Where a step of a job stands: it runs (or waits for its host), or it ended with its result and its outputs. */
export type StepState = { running: true } | { result: StepResult; outputs?: Buffer };

export interface WindowsSteps {
  hosts(): WindowsHost[];
  /**
   * Check `fields` for `job`, keep the step and begin its saga: the step's id, or a no with its HTTP status. A no is a
   * `step.refused` event. The same key again answers the same step.
   */
  start(job: Job, fields: StepFields, ask: StepAsk): { id: string } | { status: number; no: string };
  /** The saga's `run` step: takes the host lease, reads the secrets, runs the step and keeps its result. Once per step, on any host. */
  run(step: string, signal: AbortSignal): Promise<void>;
  /** The saga's `sweep` step: the host's scratch directory removed, then its host lease released. Rejects when the host could not be reached. */
  sweepHost(step: string): Promise<void>;
  /** The compensation: the host swept as far as it can be and let go, and a step not ended ends cancelled. */
  cancel(step: string, reason: string): Promise<void>;
  /** A step of the job's; undefined: no step of this job's by that id, or swept. */
  state(job: Job, id: string): StepState | undefined;
  /** The step's log from character `from`, where the next read starts, and whether the step ended (then the log is whole). */
  log(job: Job, id: string, from: number): { text: string; next: number; ended: boolean } | undefined;
  /** The job stops its step: its saga is aborted. Undefined: no step of this job's by that id. */
  stop(job: Job, id: string): boolean | undefined;
  /** Remove results older than the keep. */
  sweep(): void;
}

/** The Windows steps in the database and their sagas, as the composition root gives them to each user's runtime. */
export interface WindowsStepLedger {
  steps: WindowsStepRepository;
  sagas: { begin(step: string, userId: string): string; abort(saga: string, reason: string): boolean };
}

/** The Windows steps of a hopper that keeps none (a runtime made with no ledger): no step is ever kept. */
export const NO_WINDOWS_STEPS: WindowsStepRepository = {
  add: (step) => step, get: () => undefined, sagaIs: () => {}, inputs: () => undefined, appendLog: () => {},
  log: (_id, from) => ({ text: '', next: from }), end: () => false, outputs: () => undefined, leaseHost: () => false, runAgain: () => {}, stopped: () => {}, releaseHost: () => {}, sweep: () => {},
};

export function createWindowsSteps(o: WindowsStepsOptions): WindowsSteps {
  const newId = o.newId ?? (() => randomUUID());
  const now = o.now ?? (() => new Date());
  const keepMs = o.keepMs ?? STEP_KEEP_MS;
  const dirOf = (id: string) => join(o.dir, id);
  const hostOf = (name: string): WindowsHost | undefined => o.hosts().find((h) => h.name === name);

  const refuse = (job: Pick<Job, 'id'>, status: number, no: string, host?: string) => {
    o.record({ type: 'step.refused', jobId: job.id, data: { reason: no, ...(host !== undefined ? { host } : {}) } });
    return { status, no };
  };
  /** Ends the step with `result`, once: the end kept is the one recorded. */
  const finish = (s: WindowsStep, result: StepResult, seconds: number, outputs?: Buffer): void => {
    if (!o.steps.end(s.id, result, now().toISOString(), outputs)) return;
    o.record({ type: 'step.finished', jobId: s.jobId, data: {
      step: s.id, host: s.host, exit: result.exit, seconds,
      ...(result.outputsBytes !== undefined ? { outputsBytes: result.outputsBytes } : {}), ...(result.problem ? { problem: result.problem } : {}),
    } });
  };
  /**
   * A step's end that the database did not keep, on this hopper (issue #2117): the next try of its saga keeps it. A
   * hopper that stays up never ends a step it ran as one a stopped hopper left.
   */
  const endedHere = new Map<string, Parameters<typeof finish>>();
  const end = (...a: Parameters<typeof finish>): void => {
    try { finish(...a); } catch (e) { endedHere.set(a[0].id, a); throw e; }
    endedHere.delete(a[0].id);
  };
  const ofJob = (job: Job, id: string): WindowsStep | undefined => {
    if (!ID.test(id)) return undefined;
    const s = o.steps.get(id);
    return s && s.jobId === job.id && s.userId === o.userId ? s : undefined;
  };
  /** Why the host does not give each secret the step asks for, or undefined. */
  const notGiven = (host: WindowsHost, secrets: readonly string[]): string | undefined => {
    const gives = host.secrets ?? [];
    const outside = secrets.find((n) => !gives.includes(n));
    return outside === undefined ? undefined
      : `${host.name} does not give ${outside} to its steps: ${gives.length ? `it gives ${gives.join(', ')}` : 'it gives none'}. A person adds a secret to the host in Settings → Windows hosts.`;
  };

  const sweep = () => {
    const at = now().getTime();
    o.steps.sweep(new Date(at - keepMs).toISOString());
    // A step's directory that a stopped hopper left.
    let names: string[];
    try { names = readdirSync(o.dir); } catch { return; }
    for (const name of names) {
      try { if (at - statSync(dirOf(name)).mtimeMs > keepMs) rmSync(dirOf(name), { recursive: true, force: true }); } catch { /* gone */ }
    }
  };

  /** Runs the step on its host, which it has the lease on: its log kept as it comes, its result and outputs kept at its end. */
  const runHeld = async (s: WindowsStep, host: WindowsHost, secrets: Record<string, string>, signal: AbortSignal): Promise<void> => {
    const dir = dirOf(s.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const inputs = s.inputsBytes > 0 ? o.steps.inputs(s.id) : undefined;
    if (inputs) writeFileSync(join(dir, 'inputs.tar'), inputs, { mode: 0o600 });
    const kept = keptLog((chunk) => o.steps.appendLog(s.id, chunk), (why) => o.log(`hopper: the log of step ${s.id} is not kept from here: ${why}`));
    const masked = maskSecrets(Object.values(secrets), kept.write);
    // The step stops at its timeout, when its saga is aborted or its hopper stops, or when its job is no longer at work.
    const stop = new AbortController();
    let why: string | undefined;
    const timer = setTimeout(() => { why = `timed out after ${s.timeoutSeconds} s`; stop.abort(); }, s.timeoutSeconds * 1000);
    const watch = setInterval(() => { if (!o.atWork(s.jobId)) { why = `cancelled: job ${s.jobId} is not at work`; stop.abort(); } }, AT_WORK_MS);
    watch.unref();
    const onAbort = () => stop.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const started = now().getTime();
    o.record({ type: 'step.started', jobId: s.jobId, data: {
      step: s.id, host: s.host, command: s.command.slice(0, COMMAND_IN_EVENT), timeoutSeconds: s.timeoutSeconds,
      inputsBytes: s.inputsBytes, outputs: s.outputs, ...(s.secrets.length ? { secrets: s.secrets } : {}),
    } });
    let result: StepResult, outputs: Buffer | undefined;
    try {
      result = await o.host.run(host, { id: s.id, command: s.command, dir, inputs: inputs !== undefined, outputs: s.outputs, ...(s.secrets.length ? { secrets } : {}) }, { log: masked.write, signal: stop.signal });
      if (result.outputsBytes !== undefined) {
        if (result.outputsBytes > STEP_OUTPUTS_MAX_BYTES) result = { exit: result.exit, problem: `the outputs hold more than ${STEP_OUTPUTS_MAX_BYTES / (1024 * 1024)} MiB` };
        else outputs = readFileSync(join(dir, 'outputs.tar'));
      }
    } catch (e) {
      o.log(`hopper: step ${s.id} on ${s.host}: ${(e as Error).message}`);
      result = { exit: 255, problem: (e as Error).message };
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
      signal.removeEventListener('abort', onAbort);
      masked.end();
      for (const k of Object.keys(secrets)) delete secrets[k];
      rmSync(dir, { recursive: true, force: true });
    }
    // Its saga aborted, or its hopper stopping, keeps none: the compensation ends it, or the next try says it was cut short.
    if (signal.aborted) return;
    if (why) result = { ...result, problem: why };
    result = withLostLog(result, kept.lost());
    end(s, result, Math.round((now().getTime() - started) / 1000), outputs);
  };

  /** Waits for the step's host lease: whether it has it. A step that cannot run any more ends, saying why. */
  const takeHost = async (s: WindowsStep, signal: AbortSignal): Promise<boolean> => {
    let told = false;
    for (;;) {
      signal.throwIfAborted();
      if (!hostOf(s.host)) { finish(s, { exit: 125, problem: `the hopper has no Windows host ${s.host} any more` }, 0); return false; }
      if (!o.atWork(s.jobId)) { finish(s, { exit: 125, problem: `cancelled: job ${s.jobId} is not at work` }, 0); return false; }
      if (o.steps.leaseHost(s.id, now().toISOString())) return true;
      if (!told) { o.steps.appendLog(s.id, `hopper-step: waiting for ${s.host}: another step runs there\n`); told = true; }
      await sleep(HOLD_POLL_MS, undefined, { signal });
    }
  };

  /**
   * A step that a stopped hopper cut short, with its host lease still held: asked with rerun (issue #2117), it runs again
   * on a swept host, at most STEP_RUNS_MAX times in all, and its log says so. Whether it runs again; else it ends.
   */
  const again = async (s: WindowsStep): Promise<boolean> => {
    const run = (s.runs ?? 1) + 1, host = hostOf(s.host);
    if (!s.rerun || run > STEP_RUNS_MAX || !host) { finish(s, { exit: 125, problem: STEP_INTERRUPTED }, 0); return false; }
    if (!s.stopped) { finish(s, { exit: 125, problem: STEP_HOPPER_ENDED }, 0); return false; }
    if (!o.atWork(s.jobId)) { finish(s, { exit: 125, problem: `cancelled: job ${s.jobId} is not at work` }, 0); return false; }
    // Rejects when the host cannot be reached: the saga tries again.
    await o.host.sweep(host);
    o.steps.runAgain(s.id);
    o.steps.appendLog(s.id, `hopper-step: ${STEP_RERUN_NOTE} (run ${run} of ${STEP_RUNS_MAX})\n`);
    return true;
  };

  return {
    hosts: () => o.hosts(),
    sweep,

    start(job, fields, ask) {
      sweep();
      const request = stepRequestOf(fields);
      if ('problem' in request) return refuse(job, 400, request.problem, fields.host);
      const host = hostOf(request.host);
      if (!host) {
        const names = o.hosts().map((h) => h.name);
        return refuse(job, 404, `the hopper has no Windows host ${request.host}. ${names.length ? `It has: ${names.join(', ')}.` : 'It has none: a person adds one in Settings → Windows hosts.'}`, request.host);
      }
      const outside = notGiven(host, request.secrets);
      if (outside) return refuse(job, 403, outside, host.name);
      if (!o.sagas) return refuse(job, 503, 'this hopper runs no Windows step: it keeps no saga', host.name);
      const step = o.steps.add({
        id: newId(), userId: o.userId, jobId: job.id, key: ask.key, host: host.name, command: request.command,
        timeoutSeconds: request.timeoutSeconds, outputs: request.outputs, secrets: request.secrets, ...(fields.rerun ? { rerun: true as const } : {}),
        inputsBytes: ask.inputs.length, createdAt: now().toISOString(),
      }, ask.inputs);
      // Begun at each ask, once per step: an ask whose begin a stop cut short begins it when it is sent again.
      const saga = o.sagas.begin(step.id);
      if (step.saga !== saga) o.steps.sagaIs(step.id, saga);
      return { id: step.id };
    },

    async run(stepId, signal) {
      const s = o.steps.get(stepId);
      // Swept, or ended: nothing is left to do.
      if (!s || s.result) { endedHere.delete(stepId); return; }
      if (s.leasedAt !== undefined) {
        // Ended on this hopper, and only its end was not kept: kept now.
        const kept = endedHere.get(s.id);
        if (kept) { end(...kept); return; }
        // It took its host on a hopper that stopped: never a second time, unless it was asked with rerun.
        if (!(await again(s))) return;
      } else if (!(await takeHost(s, signal))) return;
      const host = hostOf(s.host);
      const outside = host ? notGiven(host, s.secrets) : `the hopper has no Windows host ${s.host} any more`;
      const refused = (no: string) => { refuse({ id: s.jobId }, 403, no, s.host); end(s, { exit: 125, problem: no }, 0); };
      if (!host || outside) { refused(outside!); return; }
      // From here the step may run on its host: a stop that cuts it short says so, so the next try tells it from a crash.
      const stopped = () => { try { o.steps.stopped(s.id); } catch (e) { o.log(`hopper: step ${s.id}: its stop was not kept: ${(e as Error).message}`); } };
      signal.addEventListener('abort', stopped, { once: true });
      try {
        // Read now, for this try only: no secret is kept in the database or between tries.
        const secrets: Record<string, string> = {};
        for (const name of s.secrets) {
          const r = o.secret ? await o.secret({ name, job: s.jobId, host: s.host }).catch((e: unknown) => { throw new Error(`${name}: ${(e as Error).message}`); })
            : { refused: 'the hopper gives no vault secret to a step here' };
          if ('refused' in r) { refused(`${name}: ${r.refused}`); return; }
          secrets[name] = r.value;
        }
        await runHeld(s, host, secrets, signal);
      } catch (e) {
        // A stop or an abort, or an end kept for the next try, is the saga's. Else this hopper, which stays up, says why.
        if (signal.aborted || endedHere.has(s.id)) throw e;
        o.log(`hopper: step ${s.id} on ${s.host}: ${(e as Error).message}`);
        end(s, { exit: 125, problem: `the hopper could not run the step: ${(e as Error).message}` }, 0);
      } finally {
        signal.removeEventListener('abort', stopped);
      }
    },

    async sweepHost(stepId) {
      const s = o.steps.get(stepId);
      if (!s?.hostLeased) return;
      const host = hostOf(s.host);
      // A host a person removed meanwhile keeps its scratch: the hopper reaches it no more. The next step's prepare empties it.
      if (host) await o.host.sweep(host);
      o.steps.releaseHost(s.id);
    },

    async cancel(stepId, reason) {
      const s = o.steps.get(stepId);
      if (!s) return;
      if (s.hostLeased) {
        const host = hostOf(s.host);
        // Best effort: the host is let go however the sweep goes, so a host that is away keeps no other step waiting.
        if (host) await o.host.sweep(host).catch((e: unknown) => o.log(`hopper: the scratch of step ${s.id} on ${s.host} was not swept: ${(e as Error).message}`));
        o.steps.releaseHost(s.id);
      }
      finish(s, { exit: 125, problem: `cancelled: ${reason}` }, 0);
    },

    state(job, id) {
      const s = ofJob(job, id);
      if (!s) return undefined;
      if (!s.result) return { running: true };
      const outputs = s.result.outputsBytes !== undefined ? o.steps.outputs(id) : undefined;
      return { result: s.result, ...(outputs ? { outputs } : {}) };
    },

    log(job, id, from) {
      const s = ofJob(job, id);
      if (!s) return undefined;
      // Whether it ended is read first: a log read after its end is the whole of it.
      const ended = s.result !== undefined;
      return { ...o.steps.log(id, from), ended };
    },

    stop(job, id) {
      const s = ofJob(job, id);
      if (!s) return undefined;
      return s.saga !== undefined && !s.result ? o.sagas?.abort(s.saga, `job ${job.id} stopped the step`) ?? false : false;
    },
  };
}

/** What stands in for a secret's value in the log the job reads. */
export const MASK = '***';

/**
 * The step's log as the job reads it: each secret's value replaced by `MASK`, also when a value is split across two
 * chunks — the tail that could start a value is held back until the next chunk, or `end`. Best effort: a value the
 * step changes (encodes, reverses) is not found.
 */
export function maskSecrets(values: readonly string[], out: (chunk: string) => void): { write(chunk: string): void; end(): void } {
  const secrets = values.filter((v) => v.length > 0).sort((x, y) => y.length - x.length);
  if (secrets.length === 0) return { write: out, end: () => undefined };
  const longest = secrets[0]!.length;
  let held = '';
  const mask = (s: string): string => secrets.reduce((acc, v) => acc.split(v).join(MASK), s);
  return {
    write(chunk) {
      const text = mask(held + chunk);
      // Hold back the longest tail that is the start of some value: the next chunk may finish it.
      let keep = 0;
      for (let n = Math.min(longest - 1, text.length); n > 0; n--) {
        const tail = text.slice(text.length - n);
        if (secrets.some((v) => v.startsWith(tail))) { keep = n; break; }
      }
      held = text.slice(text.length - keep);
      const now = text.slice(0, text.length - keep);
      if (now) out(now);
    },
    end() {
      if (held) out(held);
      held = '';
    },
  };
}
