// One user's need steps (issue #1007, design.md "Need steps"): a running job names what its step needs
// (`read/aws-role/<account>/<role>`), and the hopper runs that one command in a need box of a template that covers the
// needs, with credentials minted for that step only, then gives the job the output, the exit code and the outputs. The
// job stays on its own machine; no credential ever reaches it.
//
// The template: one the user has that is ready — approved, its image the approved one, every profile approved, its
// read-only check passed when it takes one — and declares every need, more needs too: the step is minted only what it
// asked for, so a wider template gives the step nothing more. The one with the fewest profiles wins. When none covers
// the needs, the job's route asks for the template as `sandbox-template` does (src/skills/template-request.ts), which
// makes it once and never twice, and the step waits until it is ready.
//
// A box step (issue #1349) is a need step too: a job whose sandbox request of a template was approved names that template
// (`sh "$HOPPER_STEP" box <template>`), and the step runs in a need box of it, minted each of the template's profiles the
// vault mints — its reads, and with an approved plan (`--plan-id`) its changes too. Each step gets a sandbox of its own,
// which is burned after it: no box waits between steps, and none joins as a machine. A box step of a template that
// gives vault secrets (issue #1875) gets them too: read for the step only, after the job's vault grant (the vault's
// `forStep`, as a Windows step's), copied into its need box beside the hopper, masked in the log, and never given to the
// job: outputs that hold a secret's value are dropped.
//
// Each step is kept in the database from the job's ask (issues #1524, #1568, design.md "Sagas: work that survives a
// stop"): its ask, its inputs, its log, its result and its outputs, in the need steps (`need_steps`). The job
// asks with a key of its own, and the same ask sent again is the same step. The hopper answers at once with the step's
// id; a `need-step` saga (need-step-saga.ts) runs it, and the job reads its log and then its result, from any host. A
// stop of the hopper never runs a step twice: a step whose need box started before the stop ends with a problem that
// says so, as it may have had its effect. Recorded on the job's timeline as a Windows step is (`step.started`,
// `step.finished`, `step.refused`), the need box as its `box`; the result and the outputs are kept an hour, then swept.
// The sandbox module keeps each need box in the sandbox runs ledger (issue #1349). However the step ends — it runs,
// fails, times out or is cancelled, a mint is refused, the job stops it, or its saga is aborted — its credentials are
// released then (issue #1371): each Kubernetes token minted for its need box stops working.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changesAsset, type OperationProfile } from '../domain/access.ts';
import { actionNeed, type AwsAction } from '../domain/action-grants.ts';
import { APPLY_STEP_OFF } from '../domain/infra-plans.ts';
import { mintKindFor, type Minted, type MintReach } from '../domain/minting.ts';
import type { NeedStep, NeedStepRepository } from '../domain/need-steps.ts';
import { templateReady as ready, templateWait } from '../domain/sandboxes-before-start.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import { isSharedSecret, type TemplateView } from '../domain/vault.ts';
import { stepRequestOf, type StepResult } from '../domain/windows-steps.ts';
import { maskSecrets, STEP_KEEP_MS } from '../windows-steps/service.ts';
import { keptLog, withLostLog } from '../windows-steps/step-log.ts';
import { needEnv, needSecrets, type NeedBox, type NeedBoxResult, type NeedCredential } from './need-box.ts';

/** The most of a step's command an event keeps. */
const COMMAND_IN_EVENT = 300;
const ID = /^[a-f0-9-]{36}$/;
/** How often a running step looks whether its job is still at work. */
const AT_WORK_MS = 5_000;
/** How often a step that waits for its sandbox host looks at it again (issue #2272). */
export const HOST_WAIT_MS = 10_000;

const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;

/** The template ready for the job's step that declares every need, the one with the fewest profiles first; undefined: none. */
export function coveringTemplate(templates: readonly TemplateView[], needs: readonly OperationProfile[], jobId: string): TemplateView | undefined {
  const wanted = needs.map(keyOf);
  return templates
    .filter((t) => ready(t, jobId) && wanted.every((k) => t.profiles.some((p) => keyOf(p) === k)))
    .sort((a, b) => a.profiles.length - b.profiles.length || a.name.localeCompare(b.name))[0];
}

/** Why a box step's outputs were not given (issue #1875). */
export const OUTPUTS_HOLD_SECRET = 'the outputs hold the value of a vault secret: they are not given to the job';

/** The problem of a step whose need box a hopper started before it stopped: it is not run again (issue #1568). */
export const STEP_INTERRUPTED = 'the hopper stopped while the step ran, and it is not run again: it may have had its effect. Look at what it changed before you run it again';

export interface NeedStepsOptions {
  userId: string;
  /** The user's templates now, as the vault shows them. */
  templates(): TemplateView[];
  /** The vault's mint for one need of the need box `step` (src/vault/need-mint.ts, given by the composition root); `plan`: the approved plan a change applies. */
  mint(ask: { template: string; step: string; job: string; profile: OperationProfile; plan?: string; actions?: AwsAction[] }): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
  /** The saved plan file of an infra plan, as the hopper keeps it (src/infra-plans/service.ts); undefined: none. */
  planFile(id: string): Buffer | undefined;
  /** Runs the need box (the sandbox module's `needStep`), `run` naming its job and step for the ledger; absent: this hopper runs no need box. */
  run?: (box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: { log(chunk: string): void; signal: AbortSignal }, run: { jobId: string; step: string; template: string }) => Promise<NeedBoxResult>;
  /** A vault secret's value for the job's box step in need box `host` of `template` (the vault's grant and checks), or why not. Absent: no step gets one. */
  secret?(ask: { name: string; job: string; host: string; template: string }): Promise<{ value: string } | { refused: string }>;
  /** Whether the sandbox runs ledger holds a run of the step: its need box started once (issue #1568). */
  ran(step: string): boolean;
  /** The step's need box ended (issue #1371): each token minted for it stops working (the vault's `releaseMints`). Never rejects. */
  release?: (box: string) => Promise<void>;
  /** The need steps, in the database. */
  steps: NeedStepRepository;
  /** The `need-step` saga of a step (need-step-saga.ts): begun once per step, its id answered; and its abort. Absent: no step runs. */
  sagas?: { begin(step: string): string; abort(saga: string, reason: string): boolean };
  /** Whether the job is at work: a step of a job that stopped is stopped too. */
  atWork(jobId: string): boolean;
  /** Where each running step's own directory goes on this machine: the hopper's work dir (scratch). */
  dir: string;
  record(event: NewEvent): void;
  log(line: string): void;
  newId?: () => string;
  now?: () => Date;
  keepMs?: number;
  /** Whether infra applies are on (issue #1722, the instance's setting, read at each ask); off, no step that applies runs. Absent: on. */
  applies?: () => boolean;
  /**
   * "sandbox host <name> is offline" while the user's sandbox host is set and none of its machines is online (issue #2272,
   * the sandbox module's `hostOffline`): the step waits, before anything is minted. Absent: it never waits.
   */
  hostOffline?: () => Promise<string | undefined>;
  /** How often a waiting step looks at the sandbox host again (default HOST_WAIT_MS). */
  hostWaitMs?: number;
}

/** What the job sent with its ask: its key for the ask, and the inputs (a tar; empty: none). */
export interface NeedStepAsk { key: string; inputs: Buffer }

/** A Linux step's fields as the job sent them, its needs read already, and the template that covers them. */
export interface NeedStepFields { template: TemplateView; needs: OperationProfile[]; command?: string; timeout?: string; outputs: string[]; plan?: string; secrets?: readonly string[]; actions?: AwsAction[] }

/** A box step's fields as the job sent them (issue #1349): the template it names, and the templates of its approved sandbox requests. */
export interface BoxStepFields { box: string; approved: readonly string[]; command?: string; timeout?: string; outputs: string[]; plan?: string; secrets: readonly string[] }

/**
 * What a box step of the template is minted (issue #1349): each profile the vault mints for a step — an aws-role, a
 * cluster or a namespace —, its reads only, and every one with an approved plan to apply; never an observe (issue #2146).
 */
export const boxNeeds = (t: TemplateView, plan: string | undefined): OperationProfile[] =>
  t.profiles.filter((p) => mintKindFor(p.asset.kind) !== undefined && p.operation !== 'observe' && (plan !== undefined || p.operation === 'read'));

/** Why a step takes no observe need (issue #2146): its port-forward is a bastion's, which outlives a step. */
export const OBSERVE_NO_STEP = 'observe is minted for a bastion only, never for a step: ask for a bastion with sh "$HOPPER_SKILL" bastion';

/** Where a step of a job stands: it runs, or it ended with its result and its outputs. */
export type NeedStepState = { running: true } | { result: StepResult; outputs?: Buffer };

export interface NeedSteps {
  /** The template ready for the job's step that covers the needs; undefined: none yet. */
  covering(needs: readonly OperationProfile[], jobId: string): TemplateView | undefined;
  /** Whether infra applies are off now (issue #1722): then no step that changes infrastructure runs, and no action grant is asked (issue #2206). */
  appliesOff(): boolean;
  /**
   * Check `fields` for `job`, keep the step and begin its saga: the step's id, or a no with its HTTP status. A no is a
   * `step.refused` event. The same key again answers the same step.
   */
  start(job: Job, fields: NeedStepFields, ask: NeedStepAsk): { id: string } | { status: number; no: string };
  /** A box step (issue #1349): a need step in a sandbox of a template the job's sandbox request was approved for. */
  box(job: Job, fields: BoxStepFields, ask: NeedStepAsk): { id: string } | { status: number; no: string };
  /** The saga's `run` step: mints, runs the need box, and keeps the result. Done once per step, on any host. */
  run(step: string, signal: AbortSignal): Promise<void>;
  /** The saga's `release` step: the step's credentials end. */
  release(step: string): Promise<void>;
  /** The compensation of `run`: the credentials end, and a step not ended ends cancelled. */
  cancel(step: string, reason: string): Promise<void>;
  /** A step of the job's; undefined: no step of this job's by that id, or swept. */
  state(job: Job, id: string): NeedStepState | undefined;
  /** The step's log from character `from`, where the next read starts, and whether the step ended (then the log is whole). */
  log(job: Job, id: string, from: number): { text: string; next: number; ended: boolean } | undefined;
  /** The job stops its step: its saga is aborted. Undefined: no step of this job's by that id. */
  stop(job: Job, id: string): boolean | undefined;
  /** Remove results older than the keep. */
  sweep(): void;
}

/** The need steps of a hopper that runs no sandbox step: none is ever kept. */
export const NO_NEED_STEPS: NeedStepRepository = {
  add: (step) => step, get: () => undefined, sagaIs: () => {}, inputs: () => undefined, appendLog: () => {},
  log: (_id, from) => ({ text: '', next: from }), end: () => false, outputs: () => undefined, sweep: () => {},
};

export function createNeedSteps(o: NeedStepsOptions): NeedSteps {
  const newId = o.newId ?? (() => randomUUID());
  const now = o.now ?? (() => new Date());
  const keepMs = o.keepMs ?? STEP_KEEP_MS;
  const dirOf = (id: string) => join(o.dir, id);
  const release = (box: string): Promise<void> => (o.release ? o.release(box).catch((e: unknown) => o.log(`hopper: the credentials of ${box} were not released: ${(e as Error).message}`)) : Promise.resolve());

  const refuse = (job: Job, status: number, no: string, box?: string) => {
    o.record({ type: 'step.refused', jobId: job.id, data: { reason: no, ...(box ? { box } : {}) } });
    return { status, no };
  };
  /** Ends the step with `result`, once: the end kept is the one recorded. */
  const finish = (s: NeedStep, result: StepResult, seconds: number, outputs?: Buffer): void => {
    if (!o.steps.end(s.id, result, now().toISOString(), outputs)) return;
    o.record({ type: 'step.finished', jobId: s.jobId, data: {
      step: s.id, box: s.box, exit: result.exit, seconds,
      ...(result.outputsBytes !== undefined ? { outputsBytes: result.outputsBytes } : {}),
      ...(result.outputsSha256 ? { outputsSha256: result.outputsSha256 } : {}), ...(result.problem ? { problem: result.problem } : {}),
    } });
  };
  const ofJob = (job: Job, id: string): NeedStep | undefined => {
    if (!ID.test(id)) return undefined;
    const s = o.steps.get(id);
    return s && s.jobId === job.id && s.userId === o.userId ? s : undefined;
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

  const start: NeedSteps['start'] = (job, fields, ask) => {
    sweep();
    const { template: t, needs } = fields;
    if (!fields.command || fields.command.trim() === '') return refuse(job, 400, 'give the command to run (sh): --command TEXT or --script FILE');
    const request = stepRequestOf({ host: t.name, command: fields.command, ...(fields.timeout !== undefined ? { timeout: fields.timeout } : {}), outputs: fields.outputs });
    if ('problem' in request) return refuse(job, 400, request.problem);
    if (needs.some((p) => p.operation === 'observe')) return refuse(job, 400, OBSERVE_NO_STEP);
    if (o.applies?.() === false && (fields.plan !== undefined || needs.some(changesAsset))) return refuse(job, 409, APPLY_STEP_OFF);
    if (!o.run || !o.sagas) return refuse(job, 503, 'this hopper runs no sandbox step: it is given no container runtime (docs/deploy.md "Sandboxes the hopper starts")');
    const id = newId();
    const step = o.steps.add({
      id, userId: o.userId, jobId: job.id, key: ask.key, box: `hopper-need-${t.name}-${id.slice(0, 8)}`,
      template: { name: t.name, image: t.image, ...(t.tools ? { tools: t.tools } : {}), ...(t.egress?.length ? { egress: t.egress } : {}), ...(t.readOnly ? { readOnly: true as const } : {}), ...(t.limits ? { limits: t.limits } : {}) },
      needs, command: request.command, timeoutSeconds: request.timeoutSeconds, outputs: request.outputs,
      ...(fields.plan ? { plan: fields.plan } : {}), ...(fields.actions?.length ? { actions: fields.actions } : {}), ...(fields.secrets?.length ? { secrets: [...fields.secrets] } : {}), inputsBytes: ask.inputs.length, createdAt: now().toISOString(),
    }, ask.inputs);
    // Begun at each ask, once per step: an ask whose begin a stop cut short begins it when it is sent again.
    const saga = o.sagas.begin(step.id);
    if (step.saga !== saga) o.steps.sagaIs(step.id, saga);
    return { id: step.id };
  };

  /**
   * Waits while the sandbox host is offline, its log saying so once per wait; whether the step goes on. It ends cancelled
   * when its job stops meanwhile, and stops waiting when its saga is aborted or its hopper stops (the saga goes on after).
   */
  const hostWait = async (s: NeedStep, signal: AbortSignal): Promise<boolean> => {
    let told: string | undefined;
    for (;;) {
      const offline = await o.hostOffline?.();
      if (offline === undefined) {
        if (told) o.steps.appendLog(s.id, 'hopper: the sandbox host is online: the step starts\n');
        return true;
      }
      if (offline !== told) {
        o.steps.appendLog(s.id, `hopper: ${offline}: the step waits for it, and never starts on another machine\n`);
        told = offline;
      }
      if (!o.atWork(s.jobId)) { finish(s, { exit: 125, problem: `cancelled: job ${s.jobId} is not at work` }, 0); return false; }
      const waited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(true); }, o.hostWaitMs ?? HOST_WAIT_MS);
        const stop = (): void => { clearTimeout(t); resolve(false); };
        signal.addEventListener('abort', stop, { once: true });
      });
      if (!waited || signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('the step was stopped while it waited for its sandbox host');
    }
  };

  /** Mints, runs the need box and keeps the result: the `run` step's do, once per step. */
  const run = async (stepId: string, signal: AbortSignal): Promise<void> => {
    const s = o.steps.get(stepId);
    // Swept, or ended: nothing is left to do.
    if (!s || s.result) return;
    const startedAt = now().getTime();
    const seconds = () => Math.round((now().getTime() - startedAt) / 1000);
    // Its need box started on a hopper that stopped: never a second time (issue #1568).
    if (o.ran(s.id)) { finish(s, { exit: 125, problem: STEP_INTERRUPTED }, 0); return; }
    if (!o.atWork(s.jobId)) { finish(s, { exit: 125, problem: `cancelled: job ${s.jobId} is not at work` }, 0); return; }
    if (!o.run) throw new Error('this hopper runs no sandbox step');
    // Issue #2272: while no machine of the sandbox host is online, the step waits, and never starts on another machine.
    // The saga's lease holds meanwhile; a stop of the hopper leaves it to wait again on any host.
    if (!(await hostWait(s, signal))) return;
    // Minted now, for this try only: no credential is kept in the database or between tries.
    const credentials: NeedCredential[] = [];
    // Issue #2206: the one change on an aws-role the granted actions narrow.
    const narrowed = s.actions?.length ? actionNeed(s.needs, true) : undefined;
    for (const profile of s.needs) {
      const actions = typeof narrowed === 'object' && keyOf(narrowed) === keyOf(profile) ? s.actions : undefined;
      const r = await o.mint({ template: s.template.name, step: s.box, job: s.jobId, profile, ...(s.plan ? { plan: s.plan } : {}), ...(actions ? { actions } : {}) });
      if ('refused' in r) {
        await release(s.box);
        const no = `${keyOf(profile)}: ${r.refused}`;
        o.record({ type: 'step.refused', jobId: s.jobId, data: { reason: no, box: s.box } });
        finish(s, { exit: 125, problem: no }, 0);
        return;
      }
      credentials.push({ profile, minted: r.minted, reach: r.reach });
    }
    // Read now, for this try only, as a Windows step's: no secret is kept in the database or between tries.
    const secrets: Record<string, string> = {};
    for (const name of s.secrets ?? []) {
      const gives = o.templates().find((t) => t.name === s.template.name)?.gives ?? [];
      const r = !gives.includes(name) ? { refused: `template ${s.template.name} does not give ${name} now` }
        : o.secret ? await o.secret({ name, job: s.jobId, host: s.box, template: s.template.name }) : { refused: 'the hopper gives no vault secret to a step here' };
      if ('refused' in r) {
        await release(s.box);
        const no = `${name}: ${r.refused}`;
        o.record({ type: 'step.refused', jobId: s.jobId, data: { reason: no, box: s.box } });
        finish(s, { exit: 125, problem: no }, 0);
        return;
      }
      secrets[name] = r.value;
    }
    const dir = dirOf(s.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const inputs = s.inputsBytes > 0 ? o.steps.inputs(s.id) : undefined;
    if (inputs) writeFileSync(join(dir, 'inputs.tar'), inputs, { mode: 0o600 });
    // The apply wrapper in the need box applies only this file: the box holds no proxy token to fetch it (issue #1007).
    const planFile = s.plan ? o.planFile(s.plan) : undefined;
    // The step stops when its saga is aborted, its hopper stops, or its job is no longer at work.
    const stopped = new AbortController();
    const watch = setInterval(() => { if (!o.atWork(s.jobId)) stopped.abort(new Error('the job is not at work')); }, AT_WORK_MS);
    watch.unref();
    const kept = keptLog((chunk) => o.steps.appendLog(s.id, chunk), (why) => o.log(`hopper: the log of sandbox step ${s.id} is not kept from here: ${why}`));
    const masked = maskSecrets([...needSecrets(credentials), ...Object.values(secrets)], kept.write);
    o.record({ type: 'step.started', jobId: s.jobId, data: {
      step: s.id, box: s.box, template: s.template.name, needs: s.needs.map(keyOf), command: s.command.slice(0, COMMAND_IN_EVENT), timeoutSeconds: s.timeoutSeconds,
      inputsBytes: s.inputsBytes, outputs: s.outputs, ...(s.secrets?.length ? { secrets: s.secrets } : {}),
    } });
    let result: StepResult, outputs: Buffer | undefined;
    try {
      const env = needEnv({ command: s.command, outputs: s.outputs, ...(s.plan ? { plan: s.plan } : {}), credentials });
      const files = { ...(inputs ? { inputs: join(dir, 'inputs.tar') } : {}), ...(planFile ? { plan: planFile } : {}), ...(s.secrets?.length ? { secrets } : {}) };
      const r = await o.run({
        name: s.box, template: s.template, env, reaches: credentials.map((c) => c.reach), timeoutMs: s.timeoutSeconds * 1000,
        dir, ...(Object.keys(files).length > 0 ? { files } : {}),
      }, { log: masked.write, signal: AbortSignal.any([signal, stopped.signal]) }, { jobId: s.jobId, step: s.id, template: s.template.name });
      // Outputs that hold a vault secret's value never go to the job (issue #1875).
      const leaks = r.outputs !== undefined && Object.values(secrets).some((v) => v.length > 0 && r.outputs!.includes(v));
      outputs = leaks ? undefined : r.outputs;
      const problem = leaks ? `${r.problem ? `${r.problem}; ` : ''}${OUTPUTS_HOLD_SECRET}` : r.problem;
      result = { exit: r.exit, ...(outputs ? { outputsBytes: outputs.length, ...(r.outputsSha256 ? { outputsSha256: r.outputsSha256 } : {}) } : {}), ...(problem ? { problem } : {}) };
    } catch (e) {
      o.log(`hopper: sandbox step ${s.id} in ${s.box}: ${(e as Error).message}`);
      result = { exit: 125, problem: (e as Error).message };
    } finally {
      clearInterval(watch);
      masked.end();
      credentials.length = 0;
      for (const k of Object.keys(secrets)) delete secrets[k];
      rmSync(dir, { recursive: true, force: true });
    }
    // Kept before the release: a stop between the two leaves the release to the saga's `release` step. Its saga
    // aborted, or its hopper stopping, keeps none: the compensation ends it, or the next try on another host does.
    if (!signal.aborted) {
      if (/timed out|did not end/.test(result.problem ?? '')) result = { ...result, problem: `timed out after ${s.timeoutSeconds} s` };
      finish(s, withLostLog(result, kept.lost()), seconds(), outputs);
    }
    // The need box is burned by now: its credentials end with it.
    await release(s.box);
  };

  return {
    covering: (needs, jobId) => coveringTemplate(o.templates(), needs, jobId), appliesOff: () => o.applies?.() === false,
    sweep,
    start,
    run,

    box(job, fields, ask) {
      const { box } = fields;
      if (!fields.approved.includes(box)) {
        const named = fields.approved.length ? `Its approved sandboxes: ${fields.approved.join(', ')}.` : 'It has none.';
        // Issue #1471: a job asks for the template it was told to use by its name.
        return refuse(job, 404, `this job has no approved sandbox of template ${box}. ${named} Ask for it: sh "$HOPPER_SKILL" sandbox --template ${box} --why "<why the job needs it>"`, box);
      }
      if (fields.secrets.length > 0) return refuse(job, 400, 'a box step takes no --secret: its sandbox gets what its template gives, its vault secrets too', box);
      const t = o.templates().find((x) => x.name === box);
      const waits = t ? templateWait(t, job.id) : 'it is not there any more';
      if (!t || waits) return refuse(job, 409, `template ${box} is not ready now: ${waits}`, box);
      return start(job, {
        // Its vault secrets: those the template gives a box's job, but a shared secret and the agent credential (a box's sign-in).
        template: t, needs: boxNeeds(t, fields.plan), outputs: fields.outputs, secrets: t.gives.filter((n) => !isSharedSecret(n) && n !== t.agentCredential),
        ...(fields.command !== undefined ? { command: fields.command } : {}), ...(fields.timeout !== undefined ? { timeout: fields.timeout } : {}), ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
      }, ask);
    },

    async release(stepId) {
      const s = o.steps.get(stepId);
      if (s) await release(s.box);
    },

    async cancel(stepId, reason) {
      const s = o.steps.get(stepId);
      if (!s) return;
      await release(s.box);
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

/**
 * The most a need or box step's inputs may hold (issue #1568): they are kept in the database until the step runs, so
 * any host can run it. More goes with the step's own command: a fetch in the box, or several steps.
 */
export const NEED_STEP_INPUTS_MAX_BYTES = 32 * 1024 * 1024;
