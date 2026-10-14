// One user's sandbox steps: Windows sandbox steps (issue #731, design.md "Windows sandbox steps") and box steps (issue
// #1004, design.md "Box steps"). A running job's step is checked against the user's Windows hosts, or the boxes the
// job's own sandbox requests started; run on its place one at a time, stopped at its timeout or when the job goes,
// recorded on the job's timeline, and its result kept for the job to fetch — an hour, then swept. A Windows step's vault
// secrets (each one its host gives, and the vault gives after the job's grant) go to the step only, and are masked in the
// log the job reads; a box step's command asks the vault itself, through the box's helper, while it runs (`onBox`).
// The Windows host is a port (`WindowsStepHost`): ssh in production, a double in tests; a box step runs through the
// sandbox module (`boxes`).
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
  /** A vault secret's value for `job`'s step on `host` (the vault's grant and checks), or why not. Absent: no step gets one. */
  secret?(ask: { name: string; job: string; host: string }): Promise<{ value: string } | { refused: string }>;
  /** The boxes a job's steps may run in (issue #1004), and how a step runs in one. Absent: no box step. */
  boxes?: StepBoxes;
  newId?: () => string;
  keepMs?: number;
}

/** A box step's place (issue #1004): the boxes of the job's own sandbox requests that run, and the run in one. */
export interface StepBoxes {
  of(job: Job): { name: string; template: string }[];
  run(job: Job, box: string, step: { id: string; command: string; dir: string; inputs: boolean; outputs: string[] }, io: { log(chunk: string): void; signal: AbortSignal }): Promise<StepResult>;
}

/** A step's fields as the job sent them. */
export interface StepFields { host?: string; box?: string; command?: string; timeout?: string; outputs: string[]; secrets?: string[] }

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
  /** The boxes `job`'s steps may run in now (issue #1004). */
  boxes(job: Job): { name: string; template: string }[];
  /** Whether a step of the job runs in the box now: the vault takes the box's ask as the job's while it does (issue #1004). */
  onBox(jobId: string, box: string): boolean;
  /** Check `fields` for `job`, and get its secrets: a step to run, or a no with its HTTP status. A no is a `step.refused` event. */
  start(job: Job, fields: StepFields): Promise<StepStart | { status: number; no: string }>;
  /** A step's result, with its outputs tar when it has one; undefined: no step of this job's by that id, or swept. */
  result(job: Job, id: string): { result: StepResult; outputs?: string } | undefined;
  /** Remove results older than the keep. */
  sweep(): void;
}

const ID = /^[a-f0-9-]{36}$/;

/** Where a step runs: its queue's key, what its events name, and the run there. */
interface Place {
  key: string;
  at: { host: string; box?: undefined } | { box: string; host?: undefined };
  run(step: { id: string; command: string; dir: string; inputs: boolean; outputs: string[] }, io: { log(chunk: string): void; signal: AbortSignal }): Promise<StepResult>;
}

export function createWindowsSteps(o: WindowsStepsOptions): WindowsSteps {
  const newId = o.newId ?? (() => randomUUID());
  const keepMs = o.keepMs ?? STEP_KEEP_MS;
  /** The tail of each host's queue: a step starts when the one before it on that host has ended. */
  const queues = new Map<string, Promise<unknown>>();
  const results = new Map<string, { jobId: string; result: StepResult; at: number }>();
  /** The box steps that run now, by step id (issue #1004). */
  const inBox = new Map<string, { jobId: string; box: string }>();
  const dirOf = (id: string) => join(o.dir, id);

  const refuse = (job: Job, status: number, no: string, at?: Place['at']) => {
    o.record({ type: 'step.refused', jobId: job.id, data: { reason: no, ...at } });
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

  /** Where the step runs: a Windows host, or a box of the job's (issue #1004); else the no. */
  const placeOf = async (job: Job, request: StepRequest, secrets: Record<string, string>): Promise<Place | { status: number; no: string }> => {
    if (request.box !== undefined) {
      const box = request.box;
      const mine = o.boxes?.of(job) ?? [];
      if (!mine.some((b) => b.name === box)) {
        return refuse(job, 404, `this job has no box ${box}. ${mine.length ? `Its boxes: ${mine.map((b) => b.name).join(', ')}.` : 'It has none: ask the hopper for one with sh "$HOPPER_SKILL" sandbox.'}`, { box });
      }
      return { key: `box ${box}`, at: { box }, run: (step, io) => o.boxes!.run(job, box, step, io) };
    }
    const host = o.hosts().find((h) => h.name === request.host);
    if (!host) {
      const names = o.hosts().map((h) => h.name);
      return refuse(job, 404, `the hopper has no Windows host ${request.host}. ${names.length ? `It has: ${names.join(', ')}.` : 'It has none: a person adds one in Settings → Windows hosts.'}`, { host: request.host! });
    }
    const gives = host.secrets ?? [];
    const outside = request.secrets.find((n) => !gives.includes(n));
    if (outside !== undefined) {
      return refuse(job, 403, `${host.name} does not give ${outside} to its steps: ${gives.length ? `it gives ${gives.join(', ')}` : 'it gives none'}. A person adds a secret to the host in Settings → Windows hosts.`, { host: host.name });
    }
    // Read now, before the inputs come: a no costs the job no upload. Held in memory for this step only.
    for (const name of request.secrets) {
      const r = o.secret ? await o.secret({ name, job: job.id, host: host.name }) : { refused: 'the hopper gives no vault secret to a step here' };
      if ('refused' in r) return refuse(job, 403, `${name}: ${r.refused}`, { host: host.name });
      secrets[name] = r.value;
    }
    return { key: host.name, at: { host: host.name }, run: (step, io) => o.host.run(host, { ...step, ...(request.secrets.length ? { secrets } : {}) }, io) };
  };

  return {
    hosts: () => o.hosts(),
    boxes: (job) => o.boxes?.of(job) ?? [],
    onBox: (jobId, box) => [...inBox.values()].some((s) => s.jobId === jobId && s.box === box),
    sweep,

    async start(job, fields) {
      sweep();
      const request = stepRequestOf(fields);
      if ('problem' in request) return refuse(job, 400, request.problem, fields.box ? { box: fields.box } : fields.host ? { host: fields.host } : undefined);
      const secrets: Record<string, string> = {};
      const place = await placeOf(job, request, secrets);
      if (!('key' in place)) return place;
      const where = place.at.host ?? place.at.box!;
      const id = newId();
      const dir = dirOf(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return {
        id, request, inputsFile: join(dir, 'inputs.tar'),
        drop(reason) {
          rmSync(dir, { recursive: true, force: true });
          refuse(job, 400, reason, place.at);
        },
        async run({ inputsBytes, log: toJob, signal }) {
          const masked = maskSecrets(Object.values(secrets), toJob);
          const log = masked.write;
          const before = queues.get(place.key);
          const stop = new AbortController();
          const onGone = () => stop.abort();
          signal.addEventListener('abort', onGone, { once: true });
          let timedOut = false;
          const mine = (async () => {
            if (before) {
              log(`hopper-step: waiting for ${where}: another step runs there\n`);
              await before.catch(() => undefined);
            }
            if (stop.signal.aborted) return { exit: 255, problem: 'stopped before it started' } satisfies StepResult;
            const started = Date.now();
            o.record({ type: 'step.started', jobId: job.id, data: {
              step: id, ...place.at, command: request.command.slice(0, COMMAND_IN_EVENT), timeoutSeconds: request.timeoutSeconds,
              inputsBytes, outputs: request.outputs, ...(request.secrets.length ? { secrets: request.secrets } : {}),
            } });
            const timer = setTimeout(() => { timedOut = true; stop.abort(); }, request.timeoutSeconds * 1000);
            let result: StepResult;
            if (place.at.box !== undefined) inBox.set(id, { jobId: job.id, box: place.at.box });
            try {
              result = await place.run({ id, command: request.command, dir, inputs: inputsBytes > 0, outputs: request.outputs }, { log, signal: stop.signal });
            } finally {
              clearTimeout(timer);
              inBox.delete(id);
              masked.end();
            }
            if (timedOut) result = { ...result, problem: `timed out after ${request.timeoutSeconds} s` };
            else if (signal.aborted) result = { ...result, problem: 'the job stopped waiting for it' };
            o.record({ type: 'step.finished', jobId: job.id, data: {
              step: id, ...place.at, exit: result.exit, seconds: Math.round((Date.now() - started) / 1000),
              ...(result.outputsBytes !== undefined ? { outputsBytes: result.outputsBytes } : {}), ...(result.problem ? { problem: result.problem } : {}),
            } });
            return result;
          })();
          queues.set(place.key, mine);
          try {
            const result = await mine;
            results.set(id, { jobId: job.id, result, at: Date.now() });
            // The inputs and the step's script are not kept: only what the job may still fetch.
            for (const f of ['inputs.tar', 'step.ps1', 'step.tar']) rmSync(join(dir, f), { force: true });
            return result;
          } catch (e) {
            o.log(`hopper: step ${id} on ${where}: ${(e as Error).message}`);
            const result = { exit: 255, problem: (e as Error).message };
            results.set(id, { jobId: job.id, result, at: Date.now() });
            return result;
          } finally {
            signal.removeEventListener('abort', onGone);
            if (queues.get(place.key) === mine) queues.delete(place.key);
            for (const k of Object.keys(secrets)) delete secrets[k];
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
