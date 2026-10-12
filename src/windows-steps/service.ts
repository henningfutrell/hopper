// One user's Windows sandbox steps (issue #731, design.md "Windows sandbox steps"): a running job's step checked against
// the user's Windows hosts, run on its host one at a time, stopped at its timeout or when the job goes, recorded on the
// job's timeline, and its result kept for the job to fetch — an hour, then swept. The host itself is the port
// (`WindowsStepHost`): ssh in production, a double in tests.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WindowsStepHost } from '../domain/ports.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import { stepRequestOf, type StepRequest, type StepResult, type WindowsHost } from '../domain/windows-steps.ts';

/** How long a step's result and outputs are kept for the job to fetch. */
export const STEP_KEEP_MS = 60 * 60 * 1000;
/** The most of a step's command an event keeps. */
const COMMAND_IN_EVENT = 300;

export interface WindowsStepsOptions {
  /** The user's Windows hosts now: a change applies to the next step. */
  hosts(): WindowsHost[];
  host: WindowsStepHost;
  /** Where each step's own directory goes on this machine: the hopper's work dir (scratch). */
  dir: string;
  record(event: NewEvent): void;
  log(line: string): void;
  newId?: () => string;
  keepMs?: number;
}

/** A step's fields as the job sent them. */
export interface StepFields { host?: string; command?: string; timeout?: string; outputs: string[] }

/** A step checked and given its own directory: the route puts the inputs in `inputsFile`, then runs it. */
export interface StepStart {
  id: string;
  request: StepRequest;
  inputsFile: string;
  /** Run it: `log` gets its output as it comes; `signal` aborts (the job's request gone). */
  run(o: { inputsBytes: number; log(chunk: string): void; signal: AbortSignal }): Promise<StepResult>;
  /** The inputs were refused (too large, cut off): the directory goes. */
  drop(reason: string): void;
}

export interface WindowsSteps {
  hosts(): WindowsHost[];
  /** Check `fields` for `job`: a step to run, or a no with its HTTP status. A no is a `step.refused` event. */
  start(job: Job, fields: StepFields): StepStart | { status: number; no: string };
  /** A step's result, with its outputs tar when it has one; undefined: no step of this job's by that id, or swept. */
  result(job: Job, id: string): { result: StepResult; outputs?: string } | undefined;
  /** Remove results older than the keep. */
  sweep(): void;
}

const ID = /^[a-f0-9-]{36}$/;

export function createWindowsSteps(o: WindowsStepsOptions): WindowsSteps {
  const newId = o.newId ?? (() => randomUUID());
  const keepMs = o.keepMs ?? STEP_KEEP_MS;
  /** The tail of each host's queue: a step starts when the one before it on that host has ended. */
  const queues = new Map<string, Promise<unknown>>();
  const results = new Map<string, { jobId: string; result: StepResult; at: number }>();
  const dirOf = (id: string) => join(o.dir, id);

  const refuse = (job: Job, status: number, no: string, host?: string) => {
    o.record({ type: 'step.refused', jobId: job.id, data: { reason: no, ...(host ? { host } : {}) } });
    return { status, no };
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, r] of results) if (now - r.at > keepMs) { results.delete(id); rmSync(dirOf(id), { recursive: true, force: true }); }
    // A directory no result names (a hopper restarted mid-step) goes once it is old.
    let names: string[];
    try { names = readdirSync(o.dir); } catch { return; }
    for (const name of names) {
      if (results.has(name)) continue;
      try { if (now - statSync(dirOf(name)).mtimeMs > keepMs) rmSync(dirOf(name), { recursive: true, force: true }); } catch { /* gone */ }
    }
  };

  return {
    hosts: () => o.hosts(),
    sweep,

    start(job, fields) {
      sweep();
      const request = stepRequestOf(fields);
      if ('problem' in request) return refuse(job, 400, request.problem, fields.host);
      const host = o.hosts().find((h) => h.name === request.host);
      if (!host) {
        const names = o.hosts().map((h) => h.name);
        return refuse(job, 404, `the hopper has no Windows host ${request.host}. ${names.length ? `It has: ${names.join(', ')}.` : 'It has none: a person adds one in Settings → Windows hosts.'}`, request.host);
      }
      const id = newId();
      const dir = dirOf(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return {
        id, request, inputsFile: join(dir, 'inputs.tar'),
        drop(reason) {
          rmSync(dir, { recursive: true, force: true });
          refuse(job, 400, reason, host.name);
        },
        async run({ inputsBytes, log, signal }) {
          const before = queues.get(host.name);
          const stop = new AbortController();
          const onGone = () => stop.abort();
          signal.addEventListener('abort', onGone, { once: true });
          let timedOut = false;
          const mine = (async () => {
            if (before) {
              log(`hopper-step: waiting for ${host.name}: another step runs there\n`);
              await before.catch(() => undefined);
            }
            if (stop.signal.aborted) return { exit: 255, problem: 'stopped before it started' } satisfies StepResult;
            const started = Date.now();
            o.record({ type: 'step.started', jobId: job.id, data: {
              step: id, host: host.name, command: request.command.slice(0, COMMAND_IN_EVENT), timeoutSeconds: request.timeoutSeconds,
              inputsBytes, outputs: request.outputs,
            } });
            const timer = setTimeout(() => { timedOut = true; stop.abort(); }, request.timeoutSeconds * 1000);
            let result: StepResult;
            try {
              result = await o.host.run(host, { id, command: request.command, dir, inputs: inputsBytes > 0, outputs: request.outputs }, { log, signal: stop.signal });
            } finally {
              clearTimeout(timer);
            }
            if (timedOut) result = { ...result, problem: `timed out after ${request.timeoutSeconds} s` };
            else if (signal.aborted) result = { ...result, problem: 'the job stopped waiting for it' };
            o.record({ type: 'step.finished', jobId: job.id, data: {
              step: id, host: host.name, exit: result.exit, seconds: Math.round((Date.now() - started) / 1000),
              ...(result.outputsBytes !== undefined ? { outputsBytes: result.outputsBytes } : {}), ...(result.problem ? { problem: result.problem } : {}),
            } });
            return result;
          })();
          queues.set(host.name, mine);
          try {
            const result = await mine;
            results.set(id, { jobId: job.id, result, at: Date.now() });
            // The inputs and the step's script are not kept: only what the job may still fetch.
            for (const f of ['inputs.tar', 'step.ps1']) rmSync(join(dir, f), { force: true });
            return result;
          } catch (e) {
            o.log(`hopper: windows step ${id} on ${host.name}: ${(e as Error).message}`);
            const result = { exit: 255, problem: (e as Error).message };
            results.set(id, { jobId: job.id, result, at: Date.now() });
            return result;
          } finally {
            signal.removeEventListener('abort', onGone);
            if (queues.get(host.name) === mine) queues.delete(host.name);
          }
        },
      };
    },

    result(job, id) {
      if (!ID.test(id)) return undefined;
      const r = results.get(id);
      if (!r || r.jobId !== job.id) return undefined;
      const outputs = join(dirOf(id), 'outputs.tar');
      return { result: r.result, ...(r.result.outputsBytes !== undefined ? { outputs } : {}) };
    },
  };
}
